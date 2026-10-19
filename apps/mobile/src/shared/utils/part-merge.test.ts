import { test } from "node:test"
import assert from "node:assert/strict"
import { applyIncomingParts } from "./part-merge.ts"
import type { Part } from "./sdk.ts"

const part = (id: string, messageID: string, text?: string): Part => ({
  id,
  messageID,
  type: "text",
  text,
})

test("empty incoming returns the map untouched (same identity)", () => {
  const current = { m1: [part("p1", "m1", "hi")] }
  assert.equal(applyIncomingParts(current, "m1", []), current)
})

test("known part is replaced (streaming growth), order preserved", () => {
  const out = applyIncomingParts({ m1: [part("p1", "m1", "hel"), part("p2", "m1", "x")] }, "m1", [
    part("p1", "m1", "hello"),
  ])
  assert.deepEqual(out.m1.map((p) => [p.id, p.text]), [
    ["p1", "hello"],
    ["p2", "x"],
  ])
})

test("unknown parts append in snapshot order, other messages untouched", () => {
  const out = applyIncomingParts({ m1: [part("p1", "m1", "a")], m2: [part("q", "m2", "z")] }, "m1", [
    part("p2", "m1", "b"),
    part("p3", "m1", "c"),
  ])
  assert.deepEqual(out.m1.map((p) => p.id), ["p1", "p2", "p3"])
  assert.deepEqual(out.m2.map((p) => p.id), ["q"])
})

test("missing message bucket is created", () => {
  const out = applyIncomingParts({}, "m9", [part("p1", "m9", "hi")])
  assert.deepEqual(out.m9.map((p) => p.id), ["p1"])
})

test("edit resend: batched parts snapshot populates the resolved message bucket", () => {
  // The edited message's echo arrives as message.created/updated with batched
  // parts under the NEW real id; the bucket is created without touching live
  // rows of other messages, and a follow-up live part.updated merges into it
  // (streaming growth, order preserved).
  const afterSnapshot = applyIncomingParts({ m1: [part("p1", "m1", "a")] }, "msg_4", [
    part("q1", "msg_4", "hello"),
    part("q2", "msg_4", "world"),
  ])
  assert.deepEqual(afterSnapshot.msg_4.map((p) => p.id), ["q1", "q2"])
  assert.deepEqual(afterSnapshot.m1.map((p) => p.id), ["p1"])
  const afterLive = applyIncomingParts(afterSnapshot, "msg_4", [part("q1", "msg_4", "hello!")])
  assert.deepEqual(afterLive.msg_4.map((p) => [p.id, p.text]), [
    ["q1", "hello!"],
    ["q2", "world"],
  ])
})
