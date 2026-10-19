import { test } from "node:test"
import assert from "node:assert/strict"
import { isTaskActive, selectActiveSessions, countActiveTasks } from "./active-tasks.ts"

const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }]

test("isTaskActive: busy/retry/sending count, idle/unknown do not", () => {
  assert.equal(isTaskActive("busy", false), true)
  assert.equal(isTaskActive("retry", false), true)
  assert.equal(isTaskActive("idle", false), false)
  assert.equal(isTaskActive(undefined, false), false)
  assert.equal(isTaskActive("idle", true), true)
  assert.equal(isTaskActive(undefined, true), true)
  assert.equal(isTaskActive(undefined, undefined), false)
})

test("stale status for a session missing from the list is ignored (the 3-vs-2 bug)", () => {
  const status = { a: { type: "busy" }, b: { type: "busy" }, ghost: { type: "busy" } }
  // Raw Object.values().filter() — the old badge logic — counts 3…
  assert.equal(Object.values(status).filter((st) => st.type === "busy").length, 3)
  // …but only the 2 loaded sessions are real tasks.
  assert.equal(countActiveTasks(sessions.slice(0, 2), status, {}), 2)
  assert.deepEqual(
    selectActiveSessions(sessions.slice(0, 2), status, {}).map((s) => s.id),
    ["a", "b"],
  )
})

test("optimistic sending bridges the tap -> SSE-busy gap in both list and count", () => {
  assert.deepEqual(selectActiveSessions(sessions, {}, { c: true }).map((s) => s.id), ["c"])
  assert.equal(countActiveTasks(sessions, {}, { c: true }), 1)
})

test("idle status plus no sending flag is not a task", () => {
  assert.equal(countActiveTasks(sessions, { a: { type: "idle" } }, {}), 0)
})
