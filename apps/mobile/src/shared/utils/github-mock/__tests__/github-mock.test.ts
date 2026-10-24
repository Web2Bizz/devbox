import { test } from "node:test"
import assert from "node:assert/strict"
import { filterMockRepos, MOCK_REPOS } from "../index.ts"

test("filterMockRepos: empty query returns all", () => {
  assert.equal(filterMockRepos("").length, MOCK_REPOS.length)
})

test("filterMockRepos: matches by name/fullName/description", () => {
  assert.ok(filterMockRepos("rush-code").length >= 1)
  assert.ok(filterMockRepos("web2bizz/").some((r) => r.fullName === "web2bizz/rush-code-core"))
})

test("filterMockRepos: no match returns empty", () => {
  assert.equal(filterMockRepos("zzz-no-such-repo").length, 0)
})
