// Single source of truth for "working task" — a session where the agent is
// currently doing something. Two places consume it and they MUST agree:
//
// - app/(tabs)/tasks.tsx renders the list of working tasks,
// - app/(tabs)/_layout.tsx shows the badge count in the Navbar.
//
// The bug this guards against: the badge counted every entry in the
// SSE-driven `sessionStatus` map (`Object.values(...).filter(busy|retry)`),
// while the Tasks screen intersected that map with the loaded `sessions`
// list. Any stale `sessionStatus` entry — a deleted session whose status was
// never cleared, a session outside the list `limit`, a missed busy -> idle
// event — made the badge show N+1 while the screen showed N (e.g. 3 vs 2).
// Both call sites must derive from the same inputs: the loaded sessions plus
// the status/sending maps. Stale entries for unknown session IDs are ignored
// here (and separately pruned at the store level — see events.ts
// pruneStaleSessionStates / removeSessionState).
export interface TaskStatusLike {
  type: string
}

export interface SessionLike {
  id: string
}

/** True when the session counts as a working task: SSE-reported busy/retry,
 *  or the optimistic `sending` flag bridging the tap -> SSE-busy gap. */
export function isTaskActive(statusType: string | undefined, sending: boolean | undefined): boolean {
  return statusType === "busy" || statusType === "retry" || sending === true
}

/** Sessions from `sessions` that are currently working tasks. Sessions absent
 *  from the loaded list never enter the result, even if the status map still
 *  holds a stale entry for them. */
export function selectActiveSessions<T extends SessionLike>(
  sessions: T[],
  sessionStatus: Record<string, TaskStatusLike | undefined>,
  sending: Record<string, boolean | undefined>,
): T[] {
  return (sessions || []).filter((session) => isTaskActive(sessionStatus[session.id]?.type, sending[session.id]))
}

/** Count matching selectActiveSessions — use this for the Navbar badge so the
 *  number always equals the number of rows on the Tasks screen. */
export function countActiveTasks(
  sessions: SessionLike[],
  sessionStatus: Record<string, TaskStatusLike | undefined>,
  sending: Record<string, boolean | undefined>,
): number {
  return selectActiveSessions(sessions, sessionStatus, sending).length
}
