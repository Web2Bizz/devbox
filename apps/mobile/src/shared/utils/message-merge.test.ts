import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeIncomingMessage } from "./message-merge.ts"
import type { Message } from "./sdk.ts"

const msg = (id: string, role: "user" | "assistant" = "user"): Message => ({
  id,
  sessionID: "s1",
  role,
  time: { created: 1 },
})

test("appends an assistant reply that has no optimistic placeholder", () => {
  const out = mergeIncomingMessage([msg("temp-1", "user")], msg("real-a", "assistant"))
  assert.deepEqual(out.map((m) => m.id), ["temp-1", "real-a"])
})

test("replaces the single pending temp user message", () => {
  const out = mergeIncomingMessage([msg("temp-1", "user")], msg("real-1", "user"))
  assert.deepEqual(out.map((m) => m.id), ["real-1"])
})

test("resolving the first message keeps a second queued temp message (the bug)", () => {
  // User sent msg1 (temp-1) then msg2 (temp-2) while msg1 was still processing.
  const list = [msg("temp-1", "user"), msg("temp-2", "user")]
  // The real event for msg1 arrives first.
  const out = mergeIncomingMessage(list, msg("real-1", "user"))
  // temp-1 is resolved; temp-2 must remain so it doesn't vanish from the UI.
  assert.deepEqual(out.map((m) => m.id), ["real-1", "temp-2"])
})

test("updates an already-present message in place without reordering", () => {
  const list = [msg("real-1", "user"), msg("real-2", "assistant")]
  const updated: Message = { ...msg("real-2", "assistant"), time: { created: 1, completed: 9 } }
  const out = mergeIncomingMessage(list, updated)
  assert.deepEqual(out.map((m) => m.id), ["real-1", "real-2"])
  assert.equal(out[1].time.completed, 9)
})

test("appends a real message when there is no matching temp and it is new", () => {
  const out = mergeIncomingMessage([msg("real-1", "user")], msg("real-2", "user"))
  assert.deepEqual(out.map((m) => m.id), ["real-1", "real-2"])
})

test("does not remove a temp of a different role", () => {
  const out = mergeIncomingMessage([msg("temp-1", "user")], msg("real-a", "assistant"))
  assert.ok(out.some((m) => m.id === "temp-1"))
})

test("edit resend: echo of the edited message resolves its own temp 1:1", () => {
  // After the sender pruned the reverted tail (see revert-prune.ts), state
  // holds [before…, temp-edit]; the server echo replaces exactly the temp —
  // a single updated row, never old+new.
  const list = [msg("msg_1"), msg("temp-9")]
  const out = mergeIncomingMessage(list, msg("msg_4", "user"))
  assert.deepEqual(out.map((m) => m.id), ["msg_1", "msg_4"])
})

test("merge never drops unrelated rows itself — tail pruning is the sender's job", () => {
  // H1/H2 boundary pin: if the reverted tail were still in state (prune
  // skipped), the echo appends and old+new coexist until a wholesale
  // refresh. The duplicate is fixed in sendMessage (revert-prune.ts), not
  // by teaching the merge to delete rows it doesn't own.
  const list = [msg("msg_1"), msg("msg_2")]
  const out = mergeIncomingMessage(list, msg("msg_4", "user"))
  assert.deepEqual(out.map((m) => m.id), ["msg_1", "msg_2", "msg_4"])
})
