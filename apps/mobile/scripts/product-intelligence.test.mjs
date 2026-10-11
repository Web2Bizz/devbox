import assert from "node:assert/strict"
import test from "node:test"

import { workflowFailures } from "./product-intelligence.mjs"

const now = Date.parse("2026-07-22T12:00:00Z")

function run(path, conclusion, hours) {
  return { path, conclusion, head_branch: "main", created_at: new Date(now - hours * 60 * 60 * 1000).toISOString() }
}

test("recovered workflow failures do not remain active", () => {
  const result = workflowFailures([
    run(".github/workflows/android.yml", "success", 1),
    run(".github/workflows/android.yml", "failure", 2),
    run(".github/workflows/android.yml", "failure", 3),
  ], now)

  assert.deepEqual(result, { failedRuns7d: 2, activeFailureStreaks: 0 })
})

test("two latest consecutive failures produce an active streak", () => {
  const result = workflowFailures([
    run(".github/workflows/android.yml", "failure", 1),
    run(".github/workflows/android.yml", "failure", 2),
    run(".github/workflows/android.yml", "success", 3),
  ], now)

  assert.deepEqual(result, { failedRuns7d: 2, activeFailureStreaks: 1 })
})

test("self-monitor runs with ref-qualified paths are excluded", () => {
  const result = workflowFailures([
    run(".github/workflows/product-intelligence.yml@refs/heads/main", "failure", 1),
    run(".github/workflows/product-intelligence.yml@refs/heads/main", "failure", 2),
  ], now)

  assert.deepEqual(result, { failedRuns7d: 0, activeFailureStreaks: 0 })
})

test("failures outside the monitored default branch are ignored", () => {
  const first = { ...run(".github/workflows/android.yml", "failure", 1), head_branch: "feature" }
  const second = { ...run(".github/workflows/android.yml", "failure", 2), head_branch: "feature" }

  assert.deepEqual(workflowFailures([first, second], now, "main"), {
    failedRuns7d: 0,
    activeFailureStreaks: 0,
  })
})
