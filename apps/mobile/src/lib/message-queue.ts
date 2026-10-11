// Client-side outbox for follow-up prompts: while the agent is busy, new
// messages wait here and flush in FIFO order as soon as the session goes
// idle — instead of hitting the server concurrently. Pure helpers so the
// ordering/removal logic is unit-testable without the Zustand store.

export interface QueuedDraft {
  id: string
  text: string
  createdAt: number
  files?: Array<{ uri: string; mime: string; filename?: string; base64?: string }>
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
}

let queueSeq = 0

export function createQueuedDraft(
  text: string,
  opts?: Pick<QueuedDraft, "files" | "model" | "agent" | "variant">,
): QueuedDraft {
  queueSeq += 1
  return {
    id: `queue-${Date.now()}-${queueSeq}`,
    text,
    createdAt: Date.now(),
    ...(opts?.files ? { files: opts.files } : {}),
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.agent ? { agent: opts.agent } : {}),
    ...(opts?.variant ? { variant: opts.variant } : {}),
  }
}

/** Append a draft to the tail (FIFO). Returns a new array. */
export function enqueueDraft(queue: QueuedDraft[], draft: QueuedDraft): QueuedDraft[] {
  return [...queue, draft]
}

/** Remove the head and return it with the rest. No-op on empty queue. */
export function dequeueDraft(queue: QueuedDraft[]): { head: QueuedDraft | undefined; rest: QueuedDraft[] } {
  if (queue.length === 0) return { head: undefined, rest: [] }
  const [head, ...rest] = queue
  return { head, rest }
}

/** Remove one draft by id. Returns a new array (same ref when untouched). */
export function removeDraft(queue: QueuedDraft[], id: string): QueuedDraft[] {
  if (!queue.some((d) => d.id === id)) return queue
  return queue.filter((d) => d.id !== id)
}

/** Replace the text of one draft by id. Returns a new array. */
export function updateDraftText(queue: QueuedDraft[], id: string, text: string): QueuedDraft[] {
  let touched = false
  const next = queue.map((d) => {
    if (d.id !== id) return d
    touched = true
    return { ...d, text }
  })
  return touched ? next : queue
}
