// Session list reads + session CRUD mutations on React Query.
//
// The query cache owns the session LIST snapshot — merged across ALL
// connections with credentials (cloud + LAN), each entry tagged with its
// origin (see ListedSession). The Zustand sessions store keeps only
// realtime/detail state (currentSession, messages, parts, sending).
// SSE handlers (events.ts) write server-pushed changes straight into the same
// cache via setQueryData, and realtime per-session cleanup (status/sending)
// runs in onSuccess — so the badge, the tasks screen and the project lists,
// which all read this one cache, can never diverge again.
import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useConnections } from "../stores/connections"
import { useEvents } from "../stores/events"
import { useSessions } from "../stores/sessions"
import { queryClient } from "../lib/query-client"
import { queryKeys } from "../lib/query-keys"
import { mergeSessionLists, type ListedSession } from "../lib/listed-session"
import type { Client, Session } from "../lib/sdk"

async function fetchSessionsList(): Promise<ListedSession[]> {
  const conn = useConnections.getState()
  // Every connection with stored credentials contributes its sessions;
  // entries without credentials (LAN added but not logged in) are skipped
  // until the user saves credentials — their 401s would only pollute the
  // merged snapshot.
  const targets = conn.connections.filter((c) => conn.clientBases[c.id]?.auth)
  const perServer = await Promise.all(
    targets.map(async ({ id }) => {
      try {
        const client = conn.clientForConnection(id)
        if (!client) return { connectionId: id, sessions: [] as Session[] }
        // Roots-shaped per server WITHOUT a limit (the server would truncate
        // before we filter); the cap applies after the merge below.
        const sessions = await client.session.list({ roots: true })
        return { connectionId: id, sessions }
      } catch {
        return { connectionId: id, sessions: [] as Session[] }
      }
    }),
  )
  return mergeSessionLists(perServer)
}

// Origin-aware client for a session: resolves against the session's OWN
// server (from the tagged cache), never assuming the active connection.
function clientForSession(sessionID: string): Client | null {
  const conn = useConnections.getState()
  const session =
    queryClient.getQueryData<ListedSession[]>(queryKeys.sessionsList)?.find((s) => s.id === sessionID) ??
    (useSessions.getState().currentSession?.id === sessionID
      ? useSessions.getState().currentSession
      : undefined)
  if (!session) return conn.client
  if (!session.directory) return conn.clientForConnection(session.connectionId) ?? conn.client
  return conn.clientForDirectory(session.directory, session.connectionId) ?? conn.client
}

export function useSessionsList() {
  const hasAuthedConnection = useConnections((s) =>
    s.connections.some((c) => s.clientBases[c.id]?.auth),
  )
  const query = useQuery({
    queryKey: queryKeys.sessionsList,
    queryFn: fetchSessionsList,
    enabled: hasAuthedConnection,
  })
  // The fresh list is authoritative about which sessions still exist: drop
  // statuses/sending flags for anything no longer present (deleted elsewhere,
  // outside the limit). Moved here from the old loadSessions() so every list
  // consumer benefits without imperative refetch calls.
  useEffect(() => {
    if (query.data) useEvents.getState().pruneStaleSessionStates(new Set(query.data.map((s) => s.id)))
  }, [query.data])
  return query
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars?: { directory?: string; title?: string; connectionId?: string }) => {
      const conn = useConnections.getState()
      const dir = vars?.directory?.trim() || undefined
      // Origin: explicit connection (e.g. a LAN project's FAB) or the active
      // one (the new-session modal).
      const originClient = vars?.connectionId ? conn.clientForConnection(vars.connectionId) : undefined
      const client =
        dir != null
          ? (conn.clientForDirectory(dir, vars?.connectionId) ?? originClient ?? conn.client)
          : (originClient ?? conn.client)
      if (!client) throw new Error("No active connection")
      const created = await client.session.create({ title: vars?.title })
      return { created, connectionId: vars?.connectionId ?? conn.activeConnection?.id ?? "" }
    },
    onSuccess: async ({ created, connectionId }, vars) => {
      // Creating into a custom folder must not mutate the connection's
      // default project — but the folder is worth remembering.
      const dir = vars?.directory?.trim() || undefined
      if (dir) await useConnections.getState().addRecentDirectory(dir)
      // Preserve the old createSession contract: the new session becomes
      // current with a clean slate (the session screen re-selects anyway).
      // Tag the origin so follow-up ops route to the right server.
      useSessions.setState({
        currentSession: { ...created, connectionId },
        messages: [],
        parts: {},
        hasMore: false,
        loadingMore: false,
      })
      await qc.invalidateQueries({ queryKey: queryKeys.sessionsList })
    },
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (sessionID: string) => {
      const client = clientForSession(sessionID)
      if (!client) throw new Error("No active connection")
      await client.session.delete(sessionID)
      return sessionID
    },
    // Optimistic: the row disappears immediately; rollback on failure.
    onMutate: async (sessionID) => {
      await qc.cancelQueries({ queryKey: queryKeys.sessionsList })
      const previous = qc.getQueryData<ListedSession[]>(queryKeys.sessionsList)
      qc.setQueryData<ListedSession[]>(queryKeys.sessionsList, (old) => (old ?? []).filter((s) => s.id !== sessionID))
      return { previous }
    },
    onError: (_err, _id, context) => {
      if (context?.previous) qc.setQueryData(queryKeys.sessionsList, context.previous)
    },
    onSuccess: (sessionID) => {
      // The server sends no busy -> idle for a deleted session — without this
      // its SSE status/sending entries would linger as a ghost task.
      useEvents.getState().removeSessionState(sessionID)
      useSessions.setState((state) => ({
        currentSession: state.currentSession?.id === sessionID ? null : state.currentSession,
        messages: state.currentSession?.id === sessionID ? [] : state.messages,
        parts: state.currentSession?.id === sessionID ? {} : state.parts,
      }))
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessionsList })
    },
  })
}

export function useRenameSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { id: string; title: string; directory?: string; connectionId?: string }) => {
      const conn = useConnections.getState()
      const client = vars.directory
        ? (conn.clientForDirectory(vars.directory, vars.connectionId) ?? conn.client)
        : (vars.connectionId ? conn.clientForConnection(vars.connectionId) : undefined) ?? conn.client
      if (!client) throw new Error("No active connection")
      await client.session.update(vars.id, { title: vars.title })
      return vars.id
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessionsList })
    },
  })
}
