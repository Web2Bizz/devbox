import assert from "node:assert/strict"
import test from "node:test"

import { parseVersion, nextDevVersion, nextMajorVersion } from "./bump-version.mjs"

test("dev bump increments patch below 9", () => {
  assert.equal(nextDevVersion("0.4.8"), "0.4.9")
})

test("dev bump carries an already-overflowed patch into minor", () => {
  // 0.4.10–0.4.15 predate the scheme (patch only lives 0–9): the first
  // automated bump lands on 0.5.0, exactly like web2bizz/ui computes it.
  assert.equal(nextDevVersion("0.4.15"), "0.5.0")
})

test("dev bump carries patch overflow into minor", () => {
  assert.equal(nextDevVersion("0.4.9"), "0.5.0")
  assert.equal(nextDevVersion("0.1.9"), "0.2.0")
})

test("dev bump carries minor==9 overflow into major", () => {
  assert.equal(nextDevVersion("0.9.9"), "1.0.0")
})

test("dev bump with minor>9 just increments minor (no major carry)", () => {
  assert.equal(nextDevVersion("0.25.9"), "0.26.0")
})

test("major bump resets minor and patch", () => {
  assert.equal(nextMajorVersion("0.4.15"), "1.0.0")
  assert.equal(nextMajorVersion("1.2.3"), "2.0.0")
  assert.equal(nextMajorVersion("0.9.9"), "1.0.0")
})

test("parseVersion strips v prefix and rejects garbage", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3 })
  assert.throws(() => parseVersion("1.2"), /Invalid semver/)
  assert.throws(() => parseVersion("x"), /Invalid semver/)
})
