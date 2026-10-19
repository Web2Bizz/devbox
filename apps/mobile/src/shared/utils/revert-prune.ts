import type { Message, Part } from "./sdk"

/**
 * Optimistically drop the reverted tail from local chat state.
 *
 * While `session.revert` is pending, the server still holds the reverted
 * message and everything after it (cleanup runs on the next prompt) and the
 * session screen only HIDES that tail with a presentation filter
 * (app/session/[id].tsx: `msg.id < revertMessageID`). The moment the next
 * prompt is accepted the tail is doomed server-side — but if it is still in
 * local state when `session.updated` clears the revert flag (which arrives
 * BEFORE the busy→idle wholesale refresh), the filter lifts and paints
 * old+new side by side: the edit-duplicate bug.
 *
 * Call this in sendMessage when a revert is pending: prune the tail
 * (`id >= revertMessageID`, same lexicographic comparison the filter uses)
 * and clear the flag optimistically. `temp-` optimistic rows are always kept
 * — they are exempt from the filter too, and dropping them would ghost a
 * message sent concurrently with the revert. On prompt failure cleanup never
 * ran, so the caller must re-sync both messages and the session object from
 * the server to restore the tail and the flag.
 *
 * Pure — unit-testable under plain `node --test`. No-op (same references)
 * when there is no pending revert.
 */
export function pruneRevertedTail(
  messages: Message[],
  parts: Record<string, Part[]>,
  revertMessageID: string | undefined | null,
): { messages: Message[]; parts: Record<string, Part[]> } {
  if (!revertMessageID) return { messages, parts }
  const pruned = messages.filter((m) => m.id.startsWith("temp-") || m.id < revertMessageID)
  if (pruned.length === messages.length) return { messages, parts }
  const keep = new Set(pruned.map((m) => m.id))
  const nextParts: Record<string, Part[]> = Object.fromEntries(
    Object.entries(parts).filter(([key]) => keep.has(key)),
  )
  return { messages: pruned, parts: nextParts }
}
