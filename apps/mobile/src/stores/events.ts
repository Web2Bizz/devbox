import { create } from "zustand"
import { useConnections } from "./connections"
import { useSessions, abortedSessions } from "./sessions"
import { send as notify } from "../lib/notifications"
import { sanitizeBody } from "../lib/notify-format"
import { statusFromPart } from "../lib/status-labels"
import { recordSuccessfulSession } from "../lib/store-review"
import { isAuthError } from "../lib/api-error"
import { isSessionActuallyIdle } from "../lib/session-status-reconcile"
import { queryClient } from "../lib/query-client"
import { queryKeys } from "../lib/query-keys"
import type { ListedSession } from "../lib/listed-session"
import type { Client, Part, Session, Message } from "../lib/sdk"

// Session status from the server
type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string }

// Pending tool-permission prompt for a session (mirrors the server shape).
export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  tool?: { messageID: string; callID: string }
}

// Pending clarifying question for a session (mirrors the server shape).
export interface QuestionRequest {
  id: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
  tool?: { messageID: string; callID: string }
}

interface EventsState {
  connected: boolean
  // Set when the last connection attempt failed with 401/403 — the server
  // rejected our credentials, not a transient network issue. The reconnect
  // loop stops retrying in this case (see connect()) since hammering a
  // fixed-credential auth failure forever just drains the battery with no
  // path to recovery (issue #76). Cleared on the next connect() attempt,
  // e.g. after the user fixes their credentials on the connection edit screen.
  authError: boolean
  reconnectAttempts: number
  lastDisconnectAt: number | null
  // Connections whose stream stopped on 401/403 (bad credentials), by id.
  // Unlike the global authError (active connection → login gate), background
  // servers must not kill app state — their streams just stop until connect()
  // runs again with fresh credentials. Surfaced in the settings server list.
  unauthorizedConnections: string[]
  sessionStatus: Record<string, SessionStatus>
  statusText: Record<string, string>
  // Permissions & questions (pending per session)
  permissions: Record<string, PermissionRequest[]>
  questions: Record<string, QuestionRequest[]>

  connect: () => void
  disconnect: () => void
  // Stop a single connection's stream (connection removed). The merged list
  // refetch drops its sessions; prune clears their statuses.
  dropConnectionStream: (connectionId: string) => void
  // Drop all per-session state (status, status text, sending flag, pending
  // prompts) for a session that no longer exists. Without this, deleting a
  // busy session leaves a stale busy entry in `sessionStatus` forever: the
  // server never sends the busy -> idle transition for a deleted session, so
  // the Navbar badge kept counting it while the Tasks screen (which
  // intersects statuses with the loaded sessions list) did not — the "3 in
  // the badge, 2 on the screen" divergence.
  removeSessionState: (sessionID: string) => void
  // Same as above, in bulk: forget every session ID not in `validIDs`.
  // Called after loadSessions() replaces the list, so statuses for sessions
  // deleted elsewhere (or fallen outside the list limit) can't linger.
  // The currently open session is always treated as valid — it may legitimately
  // be absent from the list briefly (e.g. just created, list not refreshed yet).
  pruneStaleSessionStates: (validIDs: Set<string>) => void
}

// One live SSE stream per connection (cloud + LAN in parallel), keyed by
// connection id, plus that stream's pending reconnect timer.
const streamControllers = new Map<string, AbortController>()
const streamTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Sessions that emitted session.error since they last went busy. SessionStatus
// has no error variant — an errored session still ends with a busy -> idle
// transition — so without this mark an errored run would count as a success
// toward the once-ever store review prompt.
const erroredSessions = new Set<string>()

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000] as const
const STABLE_CONNECTION_MS = 10_000
const PROLONGED_DISCONNECT_MS = 30_000

// Re-fetch pending permissions and questions from the server for a session.
// Called when entering a session to recover from missed SSE events or failed
// optimistic removals. Goes through the query cache (keyed per session) like
// every other server read; the result syncs into realtime prompt state below.
export async function refreshPending(client: Client, sessionID: string) {
  try {
    const [perms, questions] = await queryClient.fetchQuery({
      queryKey: queryKeys.sessionPending(sessionID),
      queryFn: () => Promise.all([client.permission.list(), client.question.list()]),
      staleTime: 0,
    })
    const sessionPerms = (perms || []).filter((p: Record<string, unknown>) => p.sessionID === sessionID)
    const sessionQuestions = (questions || []).filter((q: Record<string, unknown>) => q.sessionID === sessionID)
    useEvents.setState((state) => ({
      permissions: { ...state.permissions, [sessionID]: sessionPerms as any },
      questions: { ...state.questions, [sessionID]: sessionQuestions as any },
    }))
  } catch (err) {
    console.warn("[Events] Failed to refresh pending:", err)
  }
}

// sdk.ts's request() surfaces non-auth HTTP failures (e.g. 404) as a generic
// Error shaped `API Error: <status> - <body>` (see api-error.ts), so there is
// no `.status` field to branch on — parse it back out of the message.
function isNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 404)
    return true
  const message = err instanceof Error ? err.message : String(err)
  return /API Error:\s*404\b/.test(message)
}

// Clear every per-session bit for sessionID across both stores. `sending`
// lives in the sessions store while the rest lives here — both must go,
// otherwise a deleted-while-sending session leaks an optimistic flag that the
// Tasks screen would keep rendering (SSE never clears it: no idle event ever
// comes for a deleted session).
function clearSessionStateEverywhere(sessionID: string) {
  erroredSessions.delete(sessionID)
  abortedSessions.delete(sessionID)
  useEvents.setState((state) => {
    if (
      !(sessionID in state.sessionStatus) &&
      !(sessionID in state.statusText) &&
      !(state.permissions[sessionID]?.length) &&
      !(state.questions[sessionID]?.length)
    )
      return state
    const sessionStatus = { ...state.sessionStatus }
    const statusText = { ...state.statusText }
    const permissions = { ...state.permissions }
    const questions = { ...state.questions }
    delete sessionStatus[sessionID]
    delete statusText[sessionID]
    delete permissions[sessionID]
    delete questions[sessionID]
    return { sessionStatus, statusText, permissions, questions }
  })
  useSessions.setState((state) => {
    if (!(sessionID in state.sending) && !(sessionID in state.queue)) return state
    const sending = { ...state.sending }
    delete sending[sessionID]
    const queue = { ...state.queue }
    delete queue[sessionID]
    return { sending, queue }
  })
}

// Re-sync any session currently marked busy/retry against the server after an
// SSE reconnect. sessionStatus/sending are SSE-driven and there is normally
// no other path to idle — if the server's busy -> idle `session.status`
// event fired while the network was down, SSE reconnect resumes the stream
// from "now" (it does not replay missed events), so without this the busy
// flag would never clear and the UI would show a stuck 'processing' spinner
// forever (issue #123).
//
// Only ever CLEARS a flag the server confirms is stale via
// isSessionActuallyIdle — it never marks a session busy, so it can't
// clobber a genuinely still-busy session. Also re-checks sessionStatus right
// before writing, so a real session.status event that lands while the fetch
// is in flight (e.g. the session went busy again) wins over this resync.
// A 404 from the messages fetch means the session was deleted server-side
// (idle event will never come) — drop its state entirely instead of leaving
// a stale badge count behind.
async function resyncBusySessions() {
  const busySessionIDs = Object.entries(useEvents.getState().sessionStatus)
    .filter(([, status]) => status.type === "busy" || status.type === "retry")
    .map(([sessionID]) => sessionID)
  if (busySessionIDs.length === 0) return

  await Promise.all(
    busySessionIDs.map(async (sessionID) => {
      try {
        const sessionsState = useSessions.getState()
        const session =
          queryClient.getQueryData<ListedSession[]>(queryKeys.sessionsList)?.find((s) => s.id === sessionID) ??
          (sessionsState.currentSession?.id === sessionID ? sessionsState.currentSession : undefined)
        const connState = useConnections.getState()
        // Origin routing: probe the session's own server.
        const client = session
          ? session.directory
            ? connState.clientForDirectory(session.directory, session.connectionId)
            : connState.clientForConnection(session.connectionId)
          : connState.client
        if (!client) return

        const response = await client.session.messages(sessionID)
        const messages = (response || []).map((m) => m.info)
        if (!isSessionActuallyIdle(messages)) return // server says still busy - leave it alone

        // A fresh session.status event may have landed on the SSE stream
        // while this fetch was in flight — that's authoritative, don't
        // stomp on it.
        const current = useEvents.getState().sessionStatus[sessionID]?.type
        if (current !== "busy" && current !== "retry") return

        useEvents.setState((state) => ({
          sessionStatus: { ...state.sessionStatus, [sessionID]: { type: "idle" } },
          statusText: { ...state.statusText, [sessionID]: "" },
        }))
        useSessions.setState((state) => ({ sending: { ...state.sending, [sessionID]: false } }))
        if (useSessions.getState().currentSession?.id === sessionID) {
          useSessions.getState().refreshMessages()
        }
      } catch (err) {
        if (isNotFoundError(err)) {
          // Session is gone server-side — the busy -> idle event will never
          // arrive, so clear the stale flag instead of counting a ghost task.
          clearSessionStateEverywhere(sessionID)
          const cached = queryClient.getQueryData<ListedSession[]>(queryKeys.sessionsList)
          if (cached && cached.some((s) => s.id === sessionID)) {
            queryClient.setQueryData<ListedSession[]>(
              queryKeys.sessionsList,
              cached.filter((s) => s.id !== sessionID),
            )
          }
          return
        }
        console.warn("[Events] Failed to resync session status for", sessionID, err)
      }
    }),
  )
}

export const useEvents = create<EventsState>((set, get) => ({
  connected: false,
  authError: false,
  reconnectAttempts: 0,
  lastDisconnectAt: null,
  unauthorizedConnections: [],
  sessionStatus: {},
  statusText: {},
  permissions: {},
  questions: {},

  connect: () => {
    const connState = useConnections.getState()
    // Every connection with stored credentials gets a stream (cloud + LAN in
    // parallel); entries without credentials are skipped until the user saves
    // them — their 401s would only pollute the merged state.
    const targets = connState.connections.filter((c) => connState.clientBases[c.id]?.auth)
    if (targets.length === 0) return
    // Explicit (re)connect: past per-server auth failures get one fresh attempt
    // with current credentials; still-bad servers re-mark themselves below.
    if (get().unauthorizedConnections.length > 0) set({ unauthorizedConnections: [] })
    for (const target of targets) {
      if (streamControllers.has(target.id)) continue // already live
      const targetClient = connState.clientForConnection(target.id)
      if (!targetClient) continue
      runStream(target.id, targetClient)
    }

    // One SSE stream per connection. Nested here (not module-level) so the
    // loop body below closes over the store's get/set.
    function runStream(connectionId: string, client: Client) {
      const currentController = new AbortController()
      streamControllers.set(connectionId, currentController)
      set({ connected: true })
      // Clearing the global gate only makes sense for the active connection —
      // a background stream must never open it.
      if (connectionId === useConnections.getState().activeConnection?.id) set({ authError: false })
      console.log(`[SSE] Connecting to event stream (${connectionId})...`)

      // Run in background
      ;(async () => {
      let reconnectScheduled = false
      // True if this connect() call is resuming after a prior disconnect —
      // gates the one-time busy-session resync below so a cold app start
      // (sessionStatus is always empty then) never triggers it, and a run of
      // failed retries can't re-arm the check on every attempt.
      const isReconnect = get().reconnectAttempts > 0
      let resyncedAfterReconnect = false
      const stableTimer = setTimeout(() => {
        if (!currentController.signal.aborted) {
          set({ reconnectAttempts: 0, lastDisconnectAt: null })
        }
      }, STABLE_CONNECTION_MS)

      const scheduleReconnect = (reason: unknown) => {
        if (reconnectScheduled || currentController.signal.aborted) return
        reconnectScheduled = true
        // This stream is down — drop it from the live set (the timer below
        // re-adds it) so `connected` reflects the remaining streams.
        streamControllers.delete(connectionId)
        const state = get()
        const reconnectAttempts = state.reconnectAttempts + 1
        const lastDisconnectAt = state.lastDisconnectAt ?? Date.now()
        const disconnectedFor = Date.now() - lastDisconnectAt
        set({ connected: streamControllers.size > 0, reconnectAttempts, lastDisconnectAt })

        if (disconnectedFor >= PROLONGED_DISCONNECT_MS) {
          notify({
            category: "connection",
            title: "Connection interrupted",
            body: sanitizeBody(undefined, "Trying to reconnect to your server"),
            sessionId: "",
            dedupeKey: "sse-prolonged-disconnect",
            dedupeCooldownMs: 60_000,
          })
        }

        const baseDelay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts - 1, RECONNECT_DELAYS_MS.length - 1)]
        const jitteredDelay = Math.min(15_000, Math.round(baseDelay * (0.75 + Math.random() * 0.5)))
        console.warn(`[SSE] Connection lost (${connectionId}), reconnecting in ${jitteredDelay}ms:`, reason)
        streamTimers.set(
          connectionId,
          setTimeout(() => {
            streamTimers.delete(connectionId)
            streamControllers.delete(connectionId)
            // Rebuild the client on retry so saved credentials apply.
            const fresh = useConnections.getState().clientForConnection(connectionId)
            if (fresh) runStream(connectionId, fresh)
          }, jitteredDelay),
        )
      }

      try {
        for await (const event of client.global.events(currentController.signal)) {
          if (currentController.signal.aborted) break

          // The stream is genuinely live again (we're actually receiving
          // data, not just optimistically marked "connected") — resync once
          // per reconnect, not on every event.
          if (isReconnect && !resyncedAfterReconnect) {
            resyncedAfterReconnect = true
            void resyncBusySessions()
          }

          const payload = (event as any).payload || event
          const type = payload.type as string
          const props = payload.properties || {}

          switch (type) {
            case "session.status": {
              const sessionID = props.sessionID as string
              const status = props.status as SessionStatus
              if (!sessionID) break

              // Detect busy → idle transition for completion notification
              const previous = get().sessionStatus[sessionID]
              const completed = previous?.type === "busy" && status.type === "idle"

              // A new run starts — forget any error/abort from the previous one
              if (status.type === "busy") {
                erroredSessions.delete(sessionID)
                abortedSessions.delete(sessionID)
              }

              set((state) => ({
                sessionStatus: { ...state.sessionStatus, [sessionID]: status },
                // Clear status text when idle
                statusText: status.type === "idle" ? { ...state.statusText, [sessionID]: "" } : state.statusText,
              }))

              // SSE is the source of truth — update sending state unconditionally
              if (status.type === "idle") {
                useSessions.setState((state) => ({
                  sending: { ...state.sending, [sessionID]: false },
                }))
                // Refresh messages if this is the session the user is viewing
                const sessions = useSessions.getState()
                if (sessions.currentSession?.id === sessionID) {
                  sessions.refreshMessages()
                }
              }

              if (completed) {
                // A user-cancelled run still ends busy -> idle; don't count it
                // as a review-worthy success.
                const aborted = abortedSessions.has(sessionID)
                // Only notify "Task completed" for a genuine completion — a
                // user-cancelled run didn't complete, and an errored run
                // already fired its own "Session error" notification (session.error
                // doesn't touch sessionStatus, so an errored session still lands
                // here via busy→idle). Without this guard the user gets a
                // misleading — or duplicate, contradictory — completion push.
                if (!aborted && !erroredSessions.has(sessionID)) {
                  const match = queryClient
                    .getQueryData<ListedSession[]>(queryKeys.sessionsList)
                    ?.find((s) => s.id === sessionID)
                  notify({
                    category: "completed",
                    title: "Task completed",
                    body: sanitizeBody(match?.title, "Session finished processing"),
                    sessionId: sessionID,
                  })
                }
                // Genuinely positive moment — count it toward the one-time
                // store review prompt, but only if this run never errored
                // (session.error doesn't touch sessionStatus, so an errored
                // session still lands here via busy -> idle) and wasn't aborted.
                if (!aborted && !erroredSessions.has(sessionID)) void recordSuccessfulSession()
              }
              break
            }

            // A new row (e.g. the assistant reply starting to stream) arrives
            // as message.created; the final state as message.updated. Both
            // carry the same shape — handle identically, or streaming text
            // accumulates invisibly and pops in whole at completion.
            case "message.created":
            case "message.updated": {
              const info = props.info as Message | undefined
              if (!info) break
              // Forward any batched parts — the store merges them into the
              // live parts map (see handleEvent), so servers that batch parts
              // into message.updated still stream instead of popping in whole.
              useSessions
                .getState()
                .handleEvent({ type, properties: { info, parts: props.parts } } as any)
              break
            }

            case "message.part.updated": {
              const part = props.part as Part | undefined
              if (!part) break

              // Update status text from the latest part
              const sessionID = (part as any).sessionID as string
              if (sessionID) {
                set((state) => ({
                  statusText: { ...state.statusText, [sessionID]: statusFromPart(part) },
                }))
              }

              useSessions.getState().handleEvent({ type, properties: { part } } as any)
              break
            }

            case "session.updated": {
              const info = props.info as Session | undefined
              if (!info) break
              // List snapshot: patch the entry in the query cache (the open
              // session's own copy is refreshed via handleEvent below),
              // keeping its origin tag.
              const current = queryClient.getQueryData<ListedSession[]>(queryKeys.sessionsList)
              if (current && current.some((s) => s.id === info.id)) {
                queryClient.setQueryData<ListedSession[]>(
                  queryKeys.sessionsList,
                  current.map((s) => (s.id === info.id ? { ...info, connectionId } : s)),
                )
              }
              useSessions.getState().handleEvent({ type, properties: { info } } as any)
              break
            }

            case "session.created": {
              const info = props.info as Session | undefined
              if (!info) break
              // Add to the cached list snapshot (only if one exists — never
              // fabricate a partial list that would suppress the real fetch),
              // tagged with the stream's server.
              const current = queryClient.getQueryData<ListedSession[]>(queryKeys.sessionsList)
              if (current && !current.some((s) => s.id === info.id)) {
                queryClient.setQueryData<ListedSession[]>(queryKeys.sessionsList, [
                  { ...info, connectionId },
                  ...current,
                ])
              }
              break
            }

            case "session.deleted": {
              const deletedID = (props.sessionID as string) ?? (props.info as Session | undefined)?.id
              if (!deletedID) break
              // The server will never send busy -> idle for a deleted session,
              // so without this its status/sending entries would linger and
              // the Navbar badge would keep counting a ghost task.
              clearSessionStateEverywhere(deletedID)
              const cached = queryClient.getQueryData<ListedSession[]>(queryKeys.sessionsList)
              if (cached && cached.some((s) => s.id === deletedID)) {
                queryClient.setQueryData<ListedSession[]>(
                  queryKeys.sessionsList,
                  cached.filter((s) => s.id !== deletedID),
                )
              }
              useSessions.setState((state) => ({
                currentSession: state.currentSession?.id === deletedID ? null : state.currentSession,
                messages: state.currentSession?.id === deletedID ? [] : state.messages,
                parts: state.currentSession?.id === deletedID ? {} : state.parts,
              }))
              break
            }

            case "session.error": {
              const error = props.error as { message?: string } | undefined
              const sessionID = props.sessionID as string
              if (!sessionID) break
              // Mark so the eventual busy -> idle transition is not counted
              // as a success for the store review prompt
              erroredSessions.add(sessionID)
              // Clear sending state unconditionally — SSE is truth
              useSessions.setState((state) => ({
                sending: { ...state.sending, [sessionID]: false },
                // Surface error only if user is viewing this session
                ...(state.currentSession?.id === sessionID
                  ? { error: error?.message || "Session error occurred" }
                  : {}),
              }))
              if (useSessions.getState().currentSession?.id === sessionID) {
                useSessions.getState().refreshMessages()
              }
              notify({
                category: "errors",
                title: "Session error",
                body: sanitizeBody(error?.message, "Something went wrong"),
                sessionId: sessionID,
              })
              break
            }

            case "permission.asked": {
              const req = props as any
              if (!req.id || !req.sessionID) break
              const existing = get().permissions[req.sessionID] || []
              if (existing.some((item) => item.id === req.id)) break
              set((state) => ({
                permissions: {
                  ...state.permissions,
                  [req.sessionID]: [...(state.permissions[req.sessionID] || []), req],
                },
              }))
              notify({
                category: "permissions",
                title: "Agent needs approval",
                body: sanitizeBody(
                  req.permission
                    ? req.patterns?.length
                      ? `${req.permission}: ${req.patterns.join(", ")}`
                      : req.permission
                    : req.patterns?.join(", "),
                  "A tool needs your approval",
                ),
                sessionId: req.sessionID,
                dedupeKey: `perm-${req.id}`,
                dedupeCooldownMs: 60_000,
              })
              break
            }

            case "permission.replied": {
              const sessionID = props.sessionID as string
              const requestID = props.requestID as string
              if (!sessionID || !requestID) break
              set((state) => ({
                permissions: {
                  ...state.permissions,
                  [sessionID]: (state.permissions[sessionID] || []).filter((p) => p.id !== requestID),
                },
              }))
              break
            }

            case "question.asked": {
              const req = props as any
              if (!req.id || !req.sessionID) break
              const existing = get().questions[req.sessionID] || []
              if (existing.some((item) => item.id === req.id)) break
              set((state) => ({
                questions: {
                  ...state.questions,
                  [req.sessionID]: [...(state.questions[req.sessionID] || []), req],
                },
              }))
              notify({
                category: "questions",
                title: req.questions?.[0]?.header || "Input needed",
                body: sanitizeBody(req.questions?.[0]?.question, "The assistant has a question"),
                sessionId: req.sessionID,
                dedupeKey: `question-${req.id}`,
                dedupeCooldownMs: 60_000,
              })
              break
            }

            case "question.replied":
            case "question.rejected": {
              const sessionID = props.sessionID as string
              const requestID = props.requestID as string
              if (!sessionID || !requestID) break
              set((state) => ({
                questions: {
                  ...state.questions,
                  [sessionID]: (state.questions[sessionID] || []).filter((q) => q.id !== requestID),
                },
              }))
              break
            }
          }
        }

        scheduleReconnect(new Error("Event stream closed"))
      } catch (err) {
        if (isAuthError(err) && !currentController.signal.aborted) {
          streamControllers.delete(connectionId)
          if (connectionId === useConnections.getState().activeConnection?.id) {
            // Bad credentials, not a transient failure — retrying forever just
            // drains the battery with zero path to recovery (issue #76: 309
            // events / 65 users). Stop and surface a distinct state instead; the sessions screen offers a link to fix
            // credentials, which reconnects via connect() once saved.
            console.warn("[SSE] Authentication failed — stopping reconnect loop:", err)
            set({ connected: streamControllers.size > 0, authError: true })
          } else {
            // Background server with bad credentials: same no-retry rule, but
            // silent — it must not trip the global login gate. Surfaced in
            // the settings server list until credentials are saved.
            console.warn(`[SSE] Authentication failed for ${connectionId} — stopping its stream:`, err)
            set((state) => ({
              connected: streamControllers.size > 0,
              unauthorizedConnections: state.unauthorizedConnections.includes(connectionId)
                ? state.unauthorizedConnections
                : [...state.unauthorizedConnections, connectionId],
            }))
          }
        } else {
          scheduleReconnect(err)
        }
      } finally {
        clearTimeout(stableTimer)
        if (currentController.signal.aborted) {
          console.log(`[SSE] Disconnected (aborted) (${connectionId})`)
        }
      }
      })()
    }
  },

  disconnect: () => {
    console.log("[SSE] Disconnecting")
    for (const timer of streamTimers.values()) clearTimeout(timer)
    streamTimers.clear()
    for (const c of streamControllers.values()) c.abort()
    streamControllers.clear()
    erroredSessions.clear()
    abortedSessions.clear()
    // The connection identity may be changing (logout, switch, reconnect
    // with new credentials) — no cached server snapshot can be trusted.
    // Mounted queries refetch automatically once the new client is set.
    queryClient.clear()
    set({
      connected: false,
      authError: false,
      reconnectAttempts: 0,
      lastDisconnectAt: null,
      unauthorizedConnections: [],
      sessionStatus: {},
      statusText: {},
      permissions: {},
      questions: {},
    })
  },

  dropConnectionStream: (connectionId) => {
    const timer = streamTimers.get(connectionId)
    if (timer) {
      clearTimeout(timer)
      streamTimers.delete(connectionId)
    }
    const c = streamControllers.get(connectionId)
    if (c) {
      c.abort()
      streamControllers.delete(connectionId)
    }
    set({ connected: streamControllers.size > 0 })
  },

  removeSessionState: (sessionID) => {
    clearSessionStateEverywhere(sessionID)
  },

  pruneStaleSessionStates: (validIDs) => {
    const currentID = useSessions.getState().currentSession?.id
    useEvents.setState((state) => {
      const stale = Object.keys(state.sessionStatus).filter((id) => !validIDs.has(id) && id !== currentID)
      const staleText = Object.keys(state.statusText).filter((id) => !validIDs.has(id) && id !== currentID)
      if (stale.length === 0 && staleText.length === 0) return state
      const sessionStatus = { ...state.sessionStatus }
      const statusText = { ...state.statusText }
      for (const id of stale) {
        delete sessionStatus[id]
        erroredSessions.delete(id)
        abortedSessions.delete(id)
      }
      for (const id of staleText) delete statusText[id]
      return { sessionStatus, statusText }
    })
    useSessions.setState((state) => {
      const stale = Object.keys(state.sending).filter((id) => !validIDs.has(id) && id !== currentID)
      if (stale.length === 0) return state
      const sending = { ...state.sending }
      for (const id of stale) sending[id] = false
      return { sending }
    })
  },
}))
