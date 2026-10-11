import assert from "node:assert/strict"
import test from "node:test"

import { checkAppConfig, checkBundleSize } from "./verify-release-bundle.mjs"

test("a full-size bundle passes", () => {
  assert.deepEqual(checkBundleSize(3 * 1024 * 1024), [])
})

test("a truncated bundle fails", () => {
  const problems = checkBundleSize(512)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /suspiciously small/)
})

test("app.config version mismatch is reported, match is silent", () => {
  assert.deepEqual(checkAppConfig(JSON.stringify({ version: "0.4.14" }), "0.4.14"), [])
  assert.deepEqual(checkAppConfig(JSON.stringify({ version: "0.4.13" }), "0.4.14"), [
    "bundle app.config version 0.4.13, expected 0.4.14",
  ])
  assert.deepEqual(checkAppConfig("{", "0.4.14"), ["base/assets/app.config is not valid JSON"])
  assert.deepEqual(checkAppConfig("{", null), [])
})
