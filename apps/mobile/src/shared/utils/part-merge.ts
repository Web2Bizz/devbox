// Pure merge of incoming part snapshots into the per-message parts map.
// Extracted from the sessions store's SSE handlers so the rules are
// unit-testable under plain `node --test`.
import type { Part } from "./sdk"

/**
 * Merge `incoming` parts into `current[messageID]`, matching by part id:
 * known parts are replaced (streaming text grows this way), unknown ones
 * appended in snapshot order. Never drops parts the snapshot doesn't mention
 * — a snapshot is only as fresh as its send time, while live part.updated
 * events may already have landed newer rows.
 */
export function applyIncomingParts(
  current: Record<string, Part[]>,
  messageID: string,
  incoming: Part[],
): Record<string, Part[]> {
  if (!incoming || incoming.length === 0) return current
  const existing = current[messageID] || []
  const incomingById = new Map(incoming.map((p) => [p.id, p] as const))
  const merged = existing.map((p) => incomingById.get(p.id) ?? p)
  for (const part of incoming) {
    if (!existing.some((p) => p.id === part.id)) merged.push(part)
  }
  return { ...current, [messageID]: merged }
}
