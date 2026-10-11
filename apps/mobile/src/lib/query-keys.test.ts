import { test } from "node:test"
import assert from "node:assert/strict"
import { queryKeys, sessionsScopePrefix } from "./query-keys.ts"

test("list/catalog/project keys are stable literals", () => {
  assert.deepEqual([...queryKeys.sessionsList], ["sessions", "list"])
  assert.deepEqual([...queryKeys.catalog], ["catalog"])
  assert.deepEqual([...queryKeys.projectInfo], ["project", "info"])
  assert.deepEqual([...queryKeys.serverProjects], ["project", "list"])
})

test("per-session keys embed the id and stay under the sessions prefix", () => {
  assert.deepEqual([...queryKeys.sessionDetail("abc")], ["sessions", "detail", "abc"])
  assert.deepEqual([...queryKeys.sessionMessages("abc")], ["sessions", "messages", "abc"])
  assert.deepEqual([...queryKeys.sessionPending("abc")], ["sessions", "pending", "abc"])
  for (const key of [queryKeys.sessionDetail("x"), queryKeys.sessionMessages("x"), queryKeys.sessionPending("x")]) {
    assert.equal(key[0], sessionsScopePrefix[0])
  }
})

test("different sessions and scopes never collide", () => {
  assert.notDeepEqual([...queryKeys.sessionDetail("a")], [...queryKeys.sessionDetail("b")])
  assert.notDeepEqual([...queryKeys.sessionMessages("a")], [...queryKeys.sessionDetail("a")])
  assert.notDeepEqual([...queryKeys.catalog], [...queryKeys.projectInfo])
})
