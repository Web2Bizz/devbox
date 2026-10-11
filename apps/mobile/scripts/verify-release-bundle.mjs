#!/usr/bin/env node
// Verify that a release AAB is a sane artifact before it goes to Play:
// the Hermes bundle entry must exist and look like a full app bundle,
// and base/assets/app.config must be readable so the baked version can
// be reported.
//
// Usage:
//   node scripts/verify-release-bundle.mjs android/app/build/outputs/bundle/release/app-release.aab
//
// Read-only, dependency-free (uses the `unzip` CLI, present on the runner).

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"

// A real Hermes bundle for this app is several MiB. Anything below this
// floor means the archive shipped an empty or truncated bundle.
const MIN_BUNDLE_BYTES = 1024 * 1024

/** Pure check over the raw bundle size. Returns a list of problems. */
export function checkBundleSize(bytes) {
  if (bytes < MIN_BUNDLE_BYTES) {
    return [`bundle suspiciously small (${bytes} bytes) — expected a full Hermes bundle`]
  }
  return []
}

export function checkAppConfig(configJson, expectedVersion) {
  if (!expectedVersion) return []
  let version
  try {
    version = JSON.parse(configJson)?.version
  } catch {
    return ["base/assets/app.config is not valid JSON"]
  }
  return version === expectedVersion ? [] : [`bundle app.config version ${version}, expected ${expectedVersion}`]
}

function unzipEntry(archive, entry) {
  return execFileSync("unzip", ["-p", archive, entry], { maxBuffer: 256 * 1024 * 1024 })
}

function main() {
  const aab = process.argv[2]
  if (!aab || !existsSync(aab)) {
    console.error("usage: node scripts/verify-release-bundle.mjs <path-to.aab|.apk>")
    process.exit(2)
  }

  let bundle
  try {
    bundle = unzipEntry(aab, "base/assets/index.android.bundle")
  } catch {
    console.error(`FAIL ${aab}: no base/assets/index.android.bundle inside the archive`)
    process.exit(1)
  }

  const problems = [...checkBundleSize(bundle.length)]

  let version = null
  try {
    const config = unzipEntry(aab, "base/assets/app.config").toString("utf8")
    version = JSON.parse(config)?.version ?? null
  } catch {
    problems.push("could not read base/assets/app.config")
  }

  console.log(`artifact: ${aab}`)
  console.log(`bundle:   ${(bundle.length / 1024 / 1024).toFixed(2)} MiB, app version ${version ?? "unknown"}`)

  if (problems.length) {
    console.error("\nFAIL — this build must not go to Play:")
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log("\nOK — release artifact looks sane.")
}

if (import.meta.url === `file://${process.argv[1]}`) main()
