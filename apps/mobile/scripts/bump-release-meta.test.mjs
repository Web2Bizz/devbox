import assert from "node:assert/strict"
import test from "node:test"

import { nextVersionCode, changelogStub, syncGradleVersionCode } from "./bump-release-meta.mjs"

test("versionCode increments monotonically", () => {
  assert.equal(nextVersionCode(42), 43)
  assert.equal(nextVersionCode("7"), 8)
})

test("versionCode rejects garbage (never silently reset)", () => {
  assert.throws(() => nextVersionCode(0), /Invalid versionCode/)
  assert.throws(() => nextVersionCode("x"), /Invalid versionCode/)
})

test("changelog stub pins the version on its first line", () => {
  const stub = changelogStub("1.0.0")
  assert.ok(stub.split("\n", 1)[0].startsWith("v1.0.0"))
  assert.match(stub, /pending/i)
})

test("gradle versionCode line is patched, missing line throws", () => {
  const gradle = 'android {\n    defaultConfig {\n        versionCode 42\n        versionName "0.4.15"\n    }\n}'
  const out = syncGradleVersionCode(gradle, 43)
  assert.match(out, /versionCode 43/)
  assert.match(out, /versionName "0.4.15"/)
  assert.throws(() => syncGradleVersionCode("no code here", 43), /versionCode line not found/)
})
