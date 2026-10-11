// Multi-server session listing: every session rendered in a list carries the
// connection it came from, so actions (open/delete/rename) and badges can
// route to / mark the right server. Pure — unit-testable under node --test.
import type { Session } from "./sdk"
import type { ServerConnection } from "./types"

/** A session snapshot tagged with its origin connection. */
export interface ListedSession extends Session {
  connectionId: string
}

/** Ids of LAN-discovered connections (for `(local)` badges). */
export function lanConnectionIds(
  connections: Pick<ServerConnection, "id" | "discoveredOnLan">[],
): Set<string> {
  return new Set((connections || []).filter((c) => c.discoveredOnLan).map((c) => c.id))
}

/**
 * Merge per-server lists into one recency-ordered snapshot: tag each session
 * with its origin, sort most-recently-updated first, cap the total. Limit
 * applies AFTER the merge so one busy server can't starve the other out of
 * the visible list.
 */
export function mergeSessionLists(
  lists: Array<{ connectionId: string; sessions: Session[] }>,
  limit = 50,
): ListedSession[] {
  const merged: ListedSession[] = []
  for (const { connectionId, sessions } of lists || []) {
    for (const s of sessions || []) merged.push({ ...s, connectionId })
  }
  merged.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  return merged.slice(0, limit)
}
