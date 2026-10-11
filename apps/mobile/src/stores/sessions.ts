import { create } from "zustand"
import { type Session, type Message, type Part, type Event, type MessageWithParts, type Client } from "../lib/sdk"
import { useConnections } from "./connections"
import { useSettings } from "./settings"
import { mergeIncomingMessage } from "../lib/message-merge"
import { applyIncomingParts } from "../lib/part-merge"
import {
  createQueuedDraft,
  dequeueDraft,
  enqueueDraft,
  removeDraft,
  updateDraftText,
  type QueuedDraft,
} from "../lib/message-queue"
import { pruneRevertedTail } from "../lib/revert-prune"
import { isColdSessionLoad, isLiveEventForSession } from "../lib/session-load-reconcile"
import { queryClient } from "../lib/query-client"
import { queryKeys } from "../lib/query-keys"
import type { ListedSession } from "../lib/listed-session"

// State split with React Query (see src/queries/):
// - React Query owns SERVER SNAPSHOTS: the session list, catalogs, project
//   info (fetch + cache + dedup + invalidation).
// - This store owns REALTIME / DETAIL state: the open session, its messages
//   and parts with live SSE merging, optimistic sending flags, pagination.
// Snapshots seed this store (selectSession/refreshMessages fetch through the
// query cache), and SSE handlers write server-pushed changes back into the
// cache — one source of truth per concern, no mirrors.

// Helper to convert API response to our internal format
function parseMessages(response: MessageWithParts[]): { messages: Message[]; parts: Record<string, Part[]> } {
  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}

  for (const item of response || []) {
    messages.push(item.info)
    parts[item.info.id] = item.parts || []
  }

  return { messages, parts }
}

function pageSize(): number {
  return useSettings.getState().pageSize
}

interface SessionsState {
  // The open session, tagged with its origin server — every follow-up op
  // (prompt/abort/revert/messages) routes through that connection.
  currentSession: ListedSession | null
  messages: Message[]
  parts: Record<string, Part[]>
  isLoading: boolean
  // Per-session optimistic sending flag — bridging gap between user tap and SSE busy
  sending: Record<string, boolean>
  loadingMore: boolean
  hasMore: boolean
  error: string | null
  // Client-side outbox per session: follow-ups typed while the agent is
  // busy wait here and flush FIFO when the session goes idle. Keyed by
  // session id so leaving and re-entering a chat keeps its queue.
  queue: Record<string, QueuedDraft[]>

  // Actions
  selectSession: (sessionID: string, directory?: string, connectionId?: string) => Promise<void>
  loadOlderMessages: () => Promise<void>
  // Fire-and-forget prompt: the "response" arrives as streamed SSE events,
  // not as an HTTP response, so useMutation's request/response model does not
  // fit — the orchestration (optimistic message, sending flag, error + retry)
  // stays here while status/message updates flow through SSE as before.
  sendMessage: (
    text: string,
    model?: { providerID: string; modelID: string },
    agent?: string,
    files?: Array<{ uri: string; mime: string; filename?: string; base64?: string }>,
    variant?: string,
  ) => Promise<void>
  refreshMessages: () => Promise<void>

  // Outbox ops (pure FIFO, see src/lib/message-queue.ts)
  enqueueMessage: (
    sessionID: string,
    text: string,
    opts?: Pick<QueuedDraft, "files" | "model" | "agent" | "variant">,
  ) => QueuedDraft
  removeQueuedMessage: (sessionID: string, queueId: string) => void
  updateQueuedMessage: (sessionID: string, queueId: string, text: string) => void
  // Pops the head of the queue (for the auto-flush). Returns undefined when empty.
  takeNextQueued: (sessionID: string) => QueuedDraft | undefined
  clearQueue: (sessionID: string) => void

  // Clear a surfaced store error (abort/unrevert failures). The session
  // screen shows it once via alert, then clears — without this the flag
  // would re-alert on every remount.
  clearError: () => void

  // Event handling
  handleEvent: (event: Event) => void
}

// Sessions the user aborted since they last went busy. Mirrors events.ts's
// erroredSessions: SessionStatus has no "aborted" variant — an aborted run
// still ends with a busy -> idle transition — so without this mark a
// user-cancelled run would count as a success toward the store review prompt.
// events.ts (which already imports this module) clears entries on busy and
// checks them on busy -> idle.
export const abortedSessions = new Set<string>()

// Monotonic suffix for optimistic ids: two sends within the same
// millisecond must never share a `temp-` id — duplicate FlatList keys corrupt
// rendering and message merging.
export type { QueuedDraft }
let tempSeq = 0

// Monotonic token guarding selectSession against out-of-order resolution: a
// slow fetch for a session the user has already navigated away from must not
// overwrite the messages/currentSession of a newer selection. Each call takes
// the next value and only commits its result if still the latest.
let selectSeq = 0

// Get the right client for a session's directory on a given connection.
// Falls back to the active connection (legacy single-server behavior); an
// explicit but unknown connectionId yields null (no silent wrong-server).
function clientFor(directory?: string, connectionId?: string): Client | null {
  const connState = useConnections.getState()
  if (connectionId) {
    if (!directory) return connState.clientForConnection(connectionId)
    return connState.clientForDirectory(directory, connectionId)
  }
  if (!directory) return connState.client
  const connDir = connState.activeConnection?.directory
  if (directory !== connDir) return connState.clientForDirectory(directory)
  return connState.client
}

export const useSessions = create<SessionsState>((set, get) => ({
  currentSession: null,
  messages: [],
  parts: {},
  isLoading: false,
  sending: {},
  loadingMore: false,
  hasMore: false,
  error: null,
  queue: {},

  selectSession: async (sessionID, directory, connectionId) => {
    // Resolve the origin server: explicit param (navigation) → tagged cache
    // (notifications, deep links) → active connection (legacy fallback).
    const resolvedConnectionId =
      connectionId ??
      queryClient.getQueryData<ListedSession[]>(queryKeys.sessionsList)?.find((s) => s.id === sessionID)
        ?.connectionId ??
      useConnections.getState().activeConnection?.id
    const client = clientFor(directory, resolvedConnectionId)
    if (!client || !resolvedConnectionId) {
      set({ error: "No active connection" })
      return
    }

    const seq = ++selectSeq
    // Re-selecting the session already shown on screen (e.g. #121's
    // useFocusEffect resync firing again on re-entry) is a background
    // refresh, not a cold load: the screen already has this session's
    // messages, and live SSE updates keep flowing to them the whole time.
    // Forcing isLoading back to true here would hide the entire
    // conversation — including anything streaming in live right now —
    // behind a spinner for as long as this redundant fetch takes, and if it
    // stalls (flaky network), the screen looks permanently stuck "loading"
    // until the user backs out and re-enters (issue #150). Only a
    // genuinely new/different session needs the blocking spinner.
    const isColdLoad = isColdSessionLoad(get().currentSession?.id, sessionID)
    try {
      // NOTE: do NOT reset sending[sessionID] here. It bridges the gap
      // between tap and SSE busy, and selectSession runs on every screen
      // focus (see useFocusEffect) — clearing it hid the Stop button after
      // leaving and re-entering a running chat. SSE sessionStatus is the
      // source of truth and events.ts already clears `sending` on idle/error.
      set((state) => ({
        isLoading: isColdLoad ? true : state.isLoading,
        error: null,
        hasMore: false,
        loadingMore: false,
      }))

      // Seeded through the query cache: re-entering a recently seen session
      // resolves from cache (inside staleTime) instead of flashing a spinner
      // and hammering the server — live SSE updates continue on top.
      const [session, messagesResponse] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: queryKeys.sessionDetail(sessionID),
          queryFn: () => client.session.get(sessionID),
        }),
        queryClient.fetchQuery({
          queryKey: queryKeys.sessionMessages(sessionID),
          queryFn: () => client.session.messages(sessionID, { limit: pageSize() }),
        }),
      ])

      // A newer selectSession started while we were fetching — discard this
      // stale result so it can't clobber the newer selection.
      if (seq !== selectSeq) return

      // Parse the API response format: array of { info, parts }
      const { messages, parts } = parseMessages(messagesResponse)

      set({
        // Tag the origin so every follow-up op routes to the right server.
        currentSession: { ...session, connectionId: resolvedConnectionId },
        messages,
        parts,
        isLoading: false,
        // If we got exactly PAGE_SIZE messages, there are probably more
        hasMore: messagesResponse.length >= pageSize(),
      })
    } catch (err) {
      if (seq !== selectSeq) return
      console.error("Failed to load session:", err)
      set({ error: "Failed to load session", isLoading: false })
    }
  },

  loadOlderMessages: async () => {
    const client = clientFor(get().currentSession?.directory, get().currentSession?.connectionId)
    const session = get().currentSession
    if (!client || !session) return
    if (get().loadingMore || !get().hasMore) return

    try {
      set({ loadingMore: true })

      // Full-history escape hatch: fetches ALL messages bypassing the paged
      // cache entry (a different shape — unpaged) and merges locally with any
      // optimistic temp messages. Deliberately not cached: it exists to
      // collapse pagination, and the next selectSession seeds from cache.
      const response = await client.session.messages(session.id)
      const { messages: all, parts: allParts } = parseMessages(response)

      // Merge: use all messages from full fetch, but keep any temp/optimistic messages
      const existing = get().messages
      const temp = existing.filter((m) => m.id.startsWith("temp-"))
      const merged = [...all, ...temp]

      set({
        messages: merged,
        parts: { ...allParts, ...Object.fromEntries(temp.map((m) => [m.id, get().parts[m.id] || []])) },
        loadingMore: false,
        hasMore: false, // We loaded everything
      })
    } catch (error) {
      console.error("Failed to load older messages:", error)
      set({ loadingMore: false })
    }
  },

  sendMessage: async (text, model, agent, files, variant) => {
    const client = clientFor(get().currentSession?.directory, get().currentSession?.connectionId)
    const session = get().currentSession
    if (!client || !session) {
      set({ error: "No active session" })
      return
    }

    // Edit-resend: a pending session.revert means the server still holds
    // the reverted message + tail (cleanup runs inside the prompt below)
    // while the screen only HIDES them via its presentation filter. The
    // accepted prompt deletes that tail server-side — prune it locally NOW
    // and clear the flag optimistically. Otherwise session.updated clears
    // the flag before the busy→idle wholesale refresh lands, the filter
    // lifts over a stale state, and old+new paint side by side (duplicate).
    // Without a pending revert this is a no-op (same references).
    // Hoisted before try: the catch needs it to restore the flag on failure.
    const revertMessageID = session.revert?.messageID

    try {
      set((state) => ({ sending: { ...state.sending, [session.id]: true }, error: null }))

      // Add user message optimistically
      const ts = Date.now()
      const seq = tempSeq++
      const userMessage: Message = {
        id: `temp-${ts}-${seq}`,
        sessionID: session.id,
        role: "user",
        time: { created: ts },
        model,
        agent,
      }
      const optimisticParts: Part[] = []
      if (text) {
        optimisticParts.push({
          id: `temp-part-text-${ts}-${seq}`,
          messageID: userMessage.id,
          type: "text",
          text,
        })
      }
      if (files) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          optimisticParts.push({
            id: `temp-part-file-${ts}-${seq}-${i}`,
            messageID: userMessage.id,
            type: "file",
            mime: f.mime,
            url: f.uri,
            filename: f.filename,
          })
        }
      }

      set((state) => {
        const pruned = pruneRevertedTail(state.messages, state.parts, revertMessageID)
        return {
          // The pruned tail is doomed server-side once the prompt below is
          // accepted — drop the filter flag together with it so the edited
          // message's SSE echo is visible immediately instead of hidden
          // until session.updated arrives.
          currentSession:
            revertMessageID && state.currentSession?.id === session.id
              ? { ...state.currentSession, revert: undefined }
              : state.currentSession,
          messages: [...pruned.messages, userMessage],
          parts: { ...pruned.parts, [userMessage.id]: optimisticParts },
        }
      })

      // Build prompt parts - images are already converted to JPEG with base64 by toJpeg()
      const promptParts: Array<
        { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }
      > = []
      if (text) {
        promptParts.push({ type: "text", text })
      }
      if (files) {
        for (const f of files) {
          const url = f.base64 ? `data:${f.mime};base64,${f.base64}` : f.uri
          promptParts.push({ type: "file", mime: f.mime, url, filename: f.filename })
        }
      }

      // Await submission (POST to /prompt_async resolves fast, well before the
      // streamed response) so a failure here can propagate to the caller — SSE
      // events still update messages/parts/status in real-time on success.
      await client.session.prompt(session.id, { parts: promptParts, model, agent, variant })
    } catch (err) {
      console.error("[sendMessage] error:", err)
      const stillCurrent = get().currentSession?.id === session.id
      // NOTE: no store error here — the caller surfaces its own alert, and a
      // separate error effect in the session screen owns the store flag.
      // Writing both would double-alert.
      set((state) => ({
        sending: { ...state.sending, [session.id]: false },
      }))
      if (stillCurrent) {
        // The optimistic prune above assumed server cleanup ran — on failure
        // it didn't: the tail is still server-side. Re-sync messages
        // (restores the tail) and the session object (restores the still-
        // pending revert flag so the filter hides it again).
        if (revertMessageID) {
          void client.session
            .get(session.id)
            .then((fresh) => {
              if (get().currentSession?.id === session.id) {
                set({ currentSession: { ...fresh, connectionId: session.connectionId } })
              }
            })
            .catch((e) => console.error("[sendMessage] failed to restore session:", e))
        }
        get().refreshMessages()
      }
      throw err
    }
  },

  refreshMessages: async () => {
    const client = clientFor(get().currentSession?.directory, get().currentSession?.connectionId)
    const session = get().currentSession
    if (!client || !session) return

    try {
      // Explicit refresh — bypass the stale window so error/completion paths
      // always reconcile against the live server state.
      const response = await queryClient.fetchQuery({
        queryKey: queryKeys.sessionMessages(session.id),
        queryFn: () => client.session.messages(session.id),
        staleTime: 0,
      })
      const { messages, parts } = parseMessages(response)
      set({ messages, parts })
    } catch (error) {
      // Background refresh — stays silent (no store error): failures here are
      // transient noise, and the store error flag is reserved for user-facing
      // action failures (abort/unrevert) surfaced once by the session screen.
      console.error("Failed to refresh messages:", error)
    }
  },

  clearError: () => {
    set({ error: null })
  },

  enqueueMessage: (sessionID, text, opts) => {
    const draft = createQueuedDraft(text, opts)
    set((state) => ({ queue: { ...state.queue, [sessionID]: enqueueDraft(state.queue[sessionID] ?? [], draft) } }))
    return draft
  },

  removeQueuedMessage: (sessionID, queueId) => {
    set((state) => {
      const current = state.queue[sessionID] ?? []
      const next = removeDraft(current, queueId)
      if (next === current) return state
      return { queue: { ...state.queue, [sessionID]: next } }
    })
  },

  updateQueuedMessage: (sessionID, queueId, text) => {
    set((state) => {
      const current = state.queue[sessionID] ?? []
      const next = updateDraftText(current, queueId, text)
      if (next === current) return state
      return { queue: { ...state.queue, [sessionID]: next } }
    })
  },

  takeNextQueued: (sessionID) => {
    const current = get().queue[sessionID] ?? []
    const { head, rest } = dequeueDraft(current)
    if (!head) return undefined
    set((state) => ({ queue: { ...state.queue, [sessionID]: rest } }))
    return head
  },

  clearQueue: (sessionID) => {
    set((state) => {
      if (!state.queue[sessionID]?.length) return state
      return { queue: { ...state.queue, [sessionID]: [] } }
    })
  },

  handleEvent: (event) => {
    const { currentSession } = get()
    if (!currentSession) return

    const props = (event as any).properties || {}

    switch (event.type) {
      // A streaming reply announces its row via message.created and its final
      // state via message.updated — same merge for both, or text accumulates
      // invisibly and pops in whole at completion.
      case "message.created":
      case "message.updated": {
        const message = (props.info || props.message) as Message | undefined
        if (!message || !isLiveEventForSession(message.sessionID, currentSession.id)) return

        // Some servers batch part snapshots into message.updated (or a
        // part.updated got lost) — merge them so text never waits for a full
        // refresh to appear. Merge, don't replace: live part.updated rows may
        // already be newer than this snapshot.
        const incomingParts = Array.isArray((props as { parts?: unknown }).parts)
          ? ((props as { parts: Part[] }).parts ?? [])
          : []
        set((state) => ({
          messages: mergeIncomingMessage(state.messages, message),
          parts: applyIncomingParts(state.parts, message.id, incomingParts),
          // A live update for the session on screen is proof it has content
          // to show — clear any stuck spinner even if the initial (or a
          // redundant re-focus) GET hasn't resolved yet, or never does
          // (issue #150). Only ever clears, never sets it back to true.
          isLoading: false,
        }))
        break
      }

      case "message.part.updated": {
        const part = props.part as Part | undefined
        if (!part) return
        // Only handle parts for current session
        if (part.sessionID && part.sessionID !== currentSession.id) return

        set((state) => ({
          parts: applyIncomingParts(state.parts, part.messageID, [part]),
          // See message.updated above — a live part update is just as
          // much proof of life as a message update.
          isLoading: false,
        }))
        break
      }

      case "message.removed": {
        const messageID = props.messageID as string
        if (!messageID) return
        set((state) => ({
          messages: state.messages.filter((m) => m.id !== messageID),
          parts: Object.fromEntries(Object.entries(state.parts).filter(([k]) => k !== messageID)),
        }))
        break
      }

      case "session.updated": {
        const session = (props.info || props) as Session | undefined
        if (!session?.id) return

        // The list snapshot lives in the React Query cache (updated there by
        // events.ts) — here only the open session's own copy is refreshed,
        // keeping its origin tag (the event carries no connection).
        set((state) => ({
          currentSession:
            state.currentSession?.id === session.id
              ? { ...session, connectionId: state.currentSession.connectionId }
              : state.currentSession,
          isLoading: isLiveEventForSession(session.id, state.currentSession?.id) ? false : state.isLoading,
        }))
        break
      }
    }
  },
}))
