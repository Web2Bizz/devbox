// Discrete session operations as mutations: abort, revert/unrevert,
// permission/question replies.
//
// These are request/response calls with clear success/failure semantics — a
// natural fit for useMutation (no silent replays: retry is off globally).
// Live, SSE-driven flows stay in Zustand by design: sendMessage is
// fire-and-forget (the "response" arrives as streamed SSE events, not as an
// HTTP response) and message history merging is subscription state, not a
// snapshot. See the sessions store.
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ApiError, type Client } from "../lib/sdk"
import { extractPromptFromParts, type PromptFromParts } from "../lib/prompt-from-parts"
import { useConnections } from "../stores/connections"
import { useEvents, type PermissionRequest, type QuestionRequest } from "../stores/events"
import { abortedSessions, useSessions } from "../stores/sessions"
import { queryKeys } from "../lib/query-keys"
import type { ListedSession } from "../lib/listed-session"

export type RevertResult = ({ ok: true } & PromptFromParts) | { ok: false; reason: "unsupported" | "auth" | "error" }

function activeClientForCurrentSession(): { client: Client; session: ListedSession } {
  const ses = useSessions.getState()
  const conn = useConnections.getState()
  const session = ses.currentSession
  if (!session) throw new Error("No active session")
  // Origin routing: the session's own server, never the merely-active one.
  const client = session.directory
    ? conn.clientForDirectory(session.directory, session.connectionId)
    : conn.clientForConnection(session.connectionId)
  if (!client) throw new Error("No active connection")
  return { client, session }
}

export function useAbortSession() {
  return useMutation({
    mutationFn: async () => {
      const { client, session } = activeClientForCurrentSession()
      await client.session.abort(session.id)
      return session.id
    },
    onSuccess: (sessionID) => {
      // Mark only after the abort request succeeded — if it failed, the run
      // continues and any eventual completion is a genuine response.
      abortedSessions.add(sessionID)
      useSessions.setState((state) => ({ sending: { ...state.sending, [sessionID]: false } }))
    },
    onError: () => {
      useSessions.setState({ error: "Failed to abort session" })
    },
  })
}

export function useRevertSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (messageID: string): Promise<RevertResult> => {
      const { client, session } = activeClientForCurrentSession()
      try {
        const updated = await client.session.revert(session.id, messageID)
        useSessions.setState((state) => ({
          // Keep the origin tag (the server copy carries none).
          currentSession:
            state.currentSession?.id === session.id
              ? { ...updated, connectionId: session.connectionId }
              : state.currentSession,
        }))
        return { ok: true, ...extractPromptFromParts(useSessions.getState().parts[messageID]) }
      } catch (err) {
        if (err instanceof ApiError) {
          // Older servers (pre session.revert) 404 on this route — degrade
          // gracefully instead of surfacing a generic error.
          if (err.status === 404) return { ok: false, reason: "unsupported" }
          // Expired/invalid credentials — distinct from a generic failure so
          // the caller can point the user at reconnecting rather than "retry".
          if (err.status === 401 || err.status === 403) return { ok: false, reason: "auth" }
        }
        console.error("Failed to revert message:", err)
        // NOTE: no store error — the caller maps every reason to its own
        // alert; writing both would double-alert.
        return { ok: false, reason: "error" }
      }
    },
    onSuccess: (_result, _messageID) => {
      const id = useSessions.getState().currentSession?.id
      if (id) {
        // The server cleaned up messages — the cached history is stale.
        void qc.invalidateQueries({ queryKey: queryKeys.sessionMessages(id) })
        void qc.invalidateQueries({ queryKey: queryKeys.sessionsList })
      }
    },
  })
}

export function useUnrevertSession() {
  return useMutation({
    mutationFn: async () => {
      const { client, session } = activeClientForCurrentSession()
      const updated = await client.session.unrevert(session.id)
      useSessions.setState((state) => ({
        currentSession:
          state.currentSession?.id === session.id
            ? { ...updated, connectionId: session.connectionId }
            : state.currentSession,
      }))
    },
    onError: (err) => {
      console.error("Failed to unrevert session:", err)
      useSessions.setState({ error: "Failed to restore reverted messages" })
    },
  })
}

interface ReplyVars {
  client: Client
  sessionID: string
  requestID: string
}

// Optimistic shell shared by the three approval mutations below (realtime
// prompt state lives in the events store): remove the prompt immediately,
// restore the snapshot on failure. mutateAsync() still rejects on error, so
// callers keep their try/catch alerts — the rollback only restores the prompt
// for retry.
export function usePermissionReply() {
  return useMutation({
    mutationFn: (vars: ReplyVars & { reply: "once" | "always" | "reject" }) =>
      vars.client.permission.reply(vars.requestID, vars.reply),
    onMutate: (vars) => {
      const snapshot: PermissionRequest[] = useEvents.getState().permissions[vars.sessionID] ?? []
      useEvents.setState((state) => ({
        permissions: {
          ...state.permissions,
          [vars.sessionID]: snapshot.filter((p) => p.id !== vars.requestID),
        },
      }))
      return { snapshot }
    },
    onError: (_err, vars, context) => {
      if (context) {
        useEvents.setState((state) => ({
          permissions: { ...state.permissions, [vars.sessionID]: context.snapshot },
        }))
      }
    },
  })
}

export function useQuestionReply() {
  return useMutation({
    mutationFn: (vars: ReplyVars & { answers: string[][] }) =>
      vars.client.question.reply(vars.requestID, vars.answers),
    onMutate: (vars) => {
      const snapshot: QuestionRequest[] = useEvents.getState().questions[vars.sessionID] ?? []
      useEvents.setState((state) => ({
        questions: {
          ...state.questions,
          [vars.sessionID]: snapshot.filter((q) => q.id !== vars.requestID),
        },
      }))
      return { snapshot }
    },
    onError: (_err, vars, context) => {
      if (context) {
        useEvents.setState((state) => ({
          questions: { ...state.questions, [vars.sessionID]: context.snapshot },
        }))
      }
    },
  })
}

export function useQuestionReject() {
  return useMutation({
    mutationFn: (vars: ReplyVars) => vars.client.question.reject(vars.requestID),
    onMutate: (vars) => {
      const snapshot: QuestionRequest[] = useEvents.getState().questions[vars.sessionID] ?? []
      useEvents.setState((state) => ({
        questions: {
          ...state.questions,
          [vars.sessionID]: snapshot.filter((q) => q.id !== vars.requestID),
        },
      }))
      return { snapshot }
    },
    onError: (_err, vars, context) => {
      if (context) {
        useEvents.setState((state) => ({
          questions: { ...state.questions, [vars.sessionID]: context.snapshot },
        }))
      }
    },
  })
}
