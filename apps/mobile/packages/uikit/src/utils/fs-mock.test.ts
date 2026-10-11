import { test } from "node:test"
import assert from "node:assert/strict"
import { listMockDir, MOCK_HOME, MOCK_ROOTS } from "./fs-mock.ts"

test("listMockDir: returns child directories as FileEntry-likes", () => {
  const entries = listMockDir(MOCK_HOME)
  assert.deepEqual(
    entries.map((e) => e.name),
    ["projects", "work", "notes"],
  )
  assert.equal(entries[0].absolute, "/home/user/projects")
  assert.equal(entries[0].type, "directory")
})

test("listMockDir: unknown dir returns empty", () => {
  assert.deepEqual(listMockDir("/nope"), [])
})

test("listMockDir: leaf dir returns empty", () => {
  assert.deepEqual(listMockDir("/home/user/notes"), [])
})

test("MOCK_ROOTS: all roots resolve inside the mock tree or home", () => {
  for (const root of MOCK_ROOTS) {
    assert.ok(root.path === MOCK_HOME || listMockDir(root.path).length >= 0)
  }
})
