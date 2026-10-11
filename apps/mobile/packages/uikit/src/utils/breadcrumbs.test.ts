import { test } from "node:test"
import assert from "node:assert/strict"
import { breadcrumbsOf } from "./path-utils.ts"

test("breadcrumbsOf: splits absolute path into tappable segments", () => {
  assert.deepEqual(breadcrumbsOf("/home/user/proj"), [
    { label: "/", path: "/" },
    { label: "home", path: "/home" },
    { label: "user", path: "/home/user" },
    { label: "proj", path: "/home/user/proj" },
  ])
})

test("breadcrumbsOf: root yields a single segment", () => {
  assert.deepEqual(breadcrumbsOf("/"), [{ label: "/", path: "/" }])
})
