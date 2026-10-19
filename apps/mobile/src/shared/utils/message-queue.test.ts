import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createQueuedDraft, enqueueDraft, dequeueDraft, removeDraft, updateDraftText } from "./message-queue.ts"

describe("message-queue", () => {
  it("enqueues in FIFO order with unique ids", () => {
    const a = createQueuedDraft("first")
    const b = createQueuedDraft("second")
    assert.notEqual(a.id, b.id)
    let q = enqueueDraft([], a)
    q = enqueueDraft(q, b)
    assert.deepEqual(q.map((d) => d.text), ["first", "second"])
  })

  it("dequeues head first", () => {
    const q = [createQueuedDraft("1"), createQueuedDraft("2"), createQueuedDraft("3")]
    const { head, rest } = dequeueDraft(q)
    assert.equal(head?.text, "1")
    assert.deepEqual(rest.map((d) => d.text), ["2", "3"])
  })

  it("dequeue on empty is a no-op", () => {
    const { head, rest } = dequeueDraft([])
    assert.equal(head, undefined)
    assert.deepEqual(rest, [])
  })

  it("removes by id", () => {
    const a = createQueuedDraft("a")
    const b = createQueuedDraft("b")
    const q = [a, b]
    const next = removeDraft(q, a.id)
    assert.deepEqual(next.map((d) => d.id), [b.id])
    // unknown id keeps the same ref
    assert.equal(removeDraft(next, "missing"), next)
  })

  it("updates text by id", () => {
    const a = createQueuedDraft("old")
    const b = createQueuedDraft("keep")
    const next = updateDraftText([a, b], a.id, "new")
    assert.equal(next.find((d) => d.id === a.id)?.text, "new")
    assert.equal(next.find((d) => d.id === b.id)?.text, "keep")
    assert.equal(updateDraftText(next, "missing", "x"), next)
  })
})
