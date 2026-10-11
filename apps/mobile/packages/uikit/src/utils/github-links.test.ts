import { test } from "node:test"
import assert from "node:assert/strict"
import { extractGitHubUrls } from "./github-links.ts"

// Bare URLs ------------------------------------------------------------------

test("extractGitHubUrls: finds a bare repo URL", () => {
  assert.deepEqual(extractGitHubUrls("See https://github.com/owner/repo for details"), [
    "https://github.com/owner/repo",
  ])
})

test("extractGitHubUrls: finds PR / issue / blob URLs with query and anchor", () => {
  assert.deepEqual(extractGitHubUrls("Fix in https://github.com/o/r/pull/42/files?x=1#diff-2"), [
    "https://github.com/o/r/pull/42/files?x=1#diff-2",
  ])
})

test("extractGitHubUrls: matches www subdomain and http scheme", () => {
  assert.deepEqual(extractGitHubUrls("http://www.github.com/o/r and https://www.github.com/a/b"), [
    "http://www.github.com/o/r",
    "https://www.github.com/a/b",
  ])
})

// Markdown links --------------------------------------------------------------

test("extractGitHubUrls: finds the target of a markdown link", () => {
  assert.deepEqual(extractGitHubUrls("Opened [the PR](https://github.com/o/r/pull/7) upstream"), [
    "https://github.com/o/r/pull/7",
  ])
})

// Trailing punctuation --------------------------------------------------------

test("extractGitHubUrls: strips sentence punctuation glued to the URL", () => {
  assert.deepEqual(extractGitHubUrls("Repo: https://github.com/o/r. Next: https://github.com/a/b, ok?"), [
    "https://github.com/o/r",
    "https://github.com/a/b",
  ])
})

test("extractGitHubUrls: strips quotes and parentheses around the URL", () => {
  assert.deepEqual(extractGitHubUrls('("https://github.com/o/r");'), ["https://github.com/o/r"])
})

// Dedup + negatives ------------------------------------------------------------

test("extractGitHubUrls: dedupes repeats, keeps first-appearance order", () => {
  assert.deepEqual(
    extractGitHubUrls("https://github.com/b/two then https://github.com/a/one then https://github.com/b/two"),
    ["https://github.com/b/two", "https://github.com/a/one"],
  )
})

test("extractGitHubUrls: ignores non-GitHub URLs and bare domains without a path", () => {
  assert.deepEqual(extractGitHubUrls("See https://gitlab.com/o/r and https://github.com and example.github.io/x"), [])
})

test("extractGitHubUrls: returns [] for empty text or text without links", () => {
  assert.deepEqual(extractGitHubUrls(""), [])
  assert.deepEqual(extractGitHubUrls("No links here, just code `const x = 1`"), [])
})
