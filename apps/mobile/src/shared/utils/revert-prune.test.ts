import { test } from "node:test"
import assert from "node:assert/strict"
import { pruneRevertedTail } from "./revert-prune.ts"
import type { Message, Part } from "./sdk.ts"

const msg = (id: string, role: "user" | "assistant" = "user"): Message => ({
  id,
  sessionID: "s1",
  role,
  time: { created: 1 },
})

const part = (id: string, messageID: string): Part => ({ id, messageID, type: "text", text: "x" })

test("no pending revert returns the same references (no-op)", () => {
  const messages = [msg("msg_1"), msg("msg_2")]
  const parts = { msg_1: [part("p1", "msg_1")] }
  const out = pruneRevertedTail(messages, parts, undefined)
  assert.equal(out.messages, messages)
  assert.equal(out.parts, parts)
})

test("drops the reverted message and everything after it, keeps earlier", () => {
  const messages = [msg("msg_1"), msg("msg_2"), msg("msg_3")]
  const parts = {
    msg_1: [part("p1", "msg_1")],
    msg_2: [part("p2", "msg_2")],
    msg_3: [part("p3", "msg_3")],
  }
  const out = pruneRevertedTail(messages, parts, "msg_2")
  assert.deepEqual(out.messages.map((m) => m.id), ["msg_1"])
  assert.deepEqual(Object.keys(out.parts), ["msg_1"])
})

test("always keeps temp- optimistic rows (they sort after msg_ lexicographically)", () => {
  // "temp-…" > "msg_…" as strings — without the exemption the prune would eat
  // the very message being sent, same reason the screen filter exempts them.
  assert.ok("temp-1" > "msg_9")
  const messages = [msg("msg_1"), msg("msg_2"), msg("temp-1")]
  const parts = {
    msg_1: [part("p1", "msg_1")],
    msg_2: [part("p2", "msg_2")],
    "temp-1": [part("t", "temp-1")],
  }
  const out = pruneRevertedTail(messages, parts, "msg_2")
  assert.deepEqual(out.messages.map((m) => m.id), ["msg_1", "temp-1"])
  assert.deepEqual(Object.keys(out.parts).sort(), ["msg_1", "temp-1"])
})

test("no-op when the tail is already gone (same references)", () => {
  const messages = [msg("msg_1")]
  const parts = { msg_1: [part("p1", "msg_1")] }
  const out = pruneRevertedTail(messages, parts, "msg_2")
  assert.equal(out.messages, messages)
  assert.equal(out.parts, parts)
})

test("uses the same id comparison as the screen filter (lexicographic, not numeric)", () => {
  // Guards the prune/filter contract: whatever the filter hides, the prune
  // must remove — otherwise a cleared flag resurrects exactly those rows.
  const messages = [msg("msg_10"), msg("msg_2")]
  const out = pruneRevertedTail(messages, {}, "msg_2")
  // "msg_10" < "msg_2" lexicographically, so it survives both filter and prune.
  assert.deepEqual(out.messages.map((m) => m.id), ["msg_10"])
})
