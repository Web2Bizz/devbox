#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

const WEEK = 7 * 24 * 60 * 60 * 1000
const GITHUB_API = "https://api.github.com"
// This workflow's own runs must never feed the "repeated-workflow-failure"
// signal it files issues for — otherwise the job flags its own failures as
// a product signal, creating a self-sustaining feedback loop. Matched by both
// path and name so a workflow file rename doesn't silently reopen the loop.
const SELF_WORKFLOW_PATH = ".github/workflows/product-intelligence.yml"
const SELF_WORKFLOW_NAME = "Daily Product Intelligence"

export function workflowFailures(runs, now, branch) {
  const recentRuns = recent(runs, "created_at", now - WEEK).filter((run) => {
    const path = String(run.path ?? "").split("@")[0]
    const name = String(run.name ?? "")
    const selectedBranch = !branch || run.head_branch === branch
    return run.conclusion && selectedBranch && path !== SELF_WORKFLOW_PATH && name !== SELF_WORKFLOW_NAME
  })
  const workflows = new Map()
  for (const run of recentRuns) {
    const key = String(run.workflow_id ?? run.path ?? run.name ?? "unknown")
    const values = workflows.get(key) ?? []
    values.push(run)
    workflows.set(key, values)
  }

  let failedRuns7d = 0
  let activeFailureStreaks = 0
  for (const values of workflows.values()) {
    values.sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))
    failedRuns7d += values.filter((run) => run.conclusion === "failure").length
    const streak = values.findIndex((run) => run.conclusion !== "failure")
    const failures = streak === -1 ? values.length : streak
    if (failures >= 2) activeFailureStreaks += 1
  }

  return { failedRuns7d, activeFailureStreaks }
}

function args(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith("--") || !value) throw new Error(`Expected --name value, received ${key ?? "<none>"}`)
    result[key.slice(2)] = value
  }
  return result
}

function unavailable(reason) {
  return { status: "unavailable", reason }
}

function available(data) {
  return { status: "available", data }
}

async function request(source, url, headers) {
  try {
    const response = await fetch(url, { headers })
    if (!response.ok) return unavailable(`${source} returned HTTP ${response.status}`)
    return available(await response.json())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return unavailable(`${source} request failed: ${message}`)
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "opencode-mobile-product-intelligence",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

function sum(values, key) {
  return values.reduce((total, value) => total + Number(value[key] ?? 0), 0)
}

function recent(values, key, since) {
  return values.filter((value) => Date.parse(value[key] ?? "") >= since)
}

export async function collectGithub(token, repo, now) {
  if (!token) return unavailable("GITHUB_TOKEN is not set")
  const headers = githubHeaders(token)
  const base = `${GITHUB_API}/repos/${repo}`
  const issueQuery = encodeURIComponent(`repo:${repo} is:issue is:open`)
  const [repository, releases, issues, workflows, views, clones] = await Promise.all([
    request("GitHub repository", base, headers),
    request("GitHub releases", `${base}/releases?per_page=100`, headers),
    request("GitHub issue count", `${GITHUB_API}/search/issues?q=${issueQuery}`, headers),
    request("GitHub workflow runs", `${base}/actions/runs?per_page=100`, headers),
    request("GitHub traffic views", `${base}/traffic/views`, headers),
    request("GitHub traffic clones", `${base}/traffic/clones`, headers),
  ])

  const required = [repository, releases, issues, workflows]
  const failed = required.find((source) => source.status !== "available")
  if (failed) return unavailable(failed.reason)

  const releaseDownloads = releases.data.reduce(
    (total, release) => total + sum(release.assets ?? [], "download_count"),
    0,
  )
  const issueCount = Number(issues.data.total_count ?? 0)
  const runs = workflows.data.workflow_runs ?? []
  const failures = workflowFailures(runs, now, repository.data.default_branch)

  return available({
    stars: Number(repository.data.stargazers_count ?? 0),
    forks: Number(repository.data.forks_count ?? 0),
    openIssues: issueCount,
    releaseDownloads,
    failedWorkflowRuns7d: failures.failedRuns7d,
    activeWorkflowFailureStreaks: failures.activeFailureStreaks,
    traffic: {
      views:
        views.status === "available"
          ? {
              count: Number(views.data.count ?? 0),
              uniques: Number(views.data.uniques ?? 0),
            }
          : unavailable(views.reason),
      clones:
        clones.status === "available"
          ? {
              count: Number(clones.data.count ?? 0),
              uniques: Number(clones.data.uniques ?? 0),
            }
          : unavailable(clones.reason),
    },
  })
}

function sourceLine(name, source) {
  if (source.status === "available") return `| ${name} | available | current run |`
  return `| ${name} | unavailable | ${source.reason} |`
}

function metric(value) {
  return Number.isFinite(value) ? String(value) : "unavailable"
}

function trafficMetric(value) {
  if (value?.status === "unavailable") return `unavailable (${value.reason})`
  return `${metric(value.count)} total / ${metric(value.uniques)} unique`
}

function render(report) {
  const github = report.github.status === "available" ? report.github.data : null
  const state = report.material ? "material signal detected" : "no material signal detected"
  const lines = [
    `# Daily Product Intelligence - ${report.date}`,
    "",
    `**Status:** ${state}`,
    "",
    "## Source freshness",
    "",
    "| Source | Status | Detail |",
    "| --- | --- | --- |",
    sourceLine("GitHub", report.github),
    "",
    "## Current aggregate signals",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| GitHub stars | ${github ? metric(github.stars) : "unavailable"} |`,
    `| GitHub forks | ${github ? metric(github.forks) : "unavailable"} |`,
    `| Open GitHub issues | ${github ? metric(github.openIssues) : "unavailable"} |`,
    `| GitHub release asset downloads | ${github ? metric(github.releaseDownloads) : "unavailable"} |`,
    `| GitHub repository views (14-day window) | ${github ? trafficMetric(github.traffic.views) : "unavailable"} |`,
    `| GitHub repository clones (14-day window) | ${github ? trafficMetric(github.traffic.clones) : "unavailable"} |`,
    `| Failed GitHub workflow runs (7 days) | ${github ? metric(github.failedWorkflowRuns7d) : "unavailable"} |`,
    `| Workflows with an active failure streak (2+ latest runs) | ${github ? metric(github.activeWorkflowFailureStreaks) : "unavailable"} |`,
    "",
    "## Deferred metrics",
    "",
    "| Metric | Status | Reason |",
    "| --- | --- | --- |",
    "| Play acquisition and uninstall metrics | deferred | Requires a verified least-privilege reporting source. |",
    "| Play review themes | deferred | Review ingestion needs privacy-safe dedupe and redaction. |",
    "| Activation funnel | deferred | Requires explicit product-usage consent and disclosure review. |",
    "| Retention | deferred | No consent-safe active-install measurement is implemented. |",
    "| Website conversion | deferred | Vercel Analytics export contract is not implemented. |",
    "",
    "## Triage rule",
    "",
    "A single deduplicated implementation issue is created only when a non-monitor GitHub workflow's latest two or more runs failed consecutively. Historical failures followed by a successful run remain visible in metrics but do not trigger an issue. This report intentionally contains no raw diagnostic, review, request, or user-generated content.",
  ]
  return `${lines.join("\n")}\n`
}

async function write(path, contents) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

async function main() {
  const options = args(process.argv.slice(2))
  const now = Date.now()
  const date = new Date(now).toISOString().slice(0, 10)
  const repo = process.env.GITHUB_REPOSITORY ?? "dzianisv/opencode-mobile"
  const github = await collectGithub(process.env.GITHUB_TOKEN, repo, now)
  const githubData = github.status === "available" ? github.data : null
  const signals = []
  if (githubData?.activeWorkflowFailureStreaks >= 1) signals.push("repeated-workflow-failure")

  const report = {
    date,
    generatedAt: new Date(now).toISOString(),
    repo,
    github,
    material: signals.length > 0,
    signals,
  }
  const markdown = render(report)

  await write(options.report, markdown)
  await write(options.json, `${JSON.stringify(report, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) await write(process.env.GITHUB_STEP_SUMMARY, markdown)

  console.log(`Product intelligence report written for ${date}.`)
  // GitHub is required: this job has no way to compute its signal without
  // it, so its unavailability is a genuine failure.
  if (github.status !== "available") {
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Product intelligence failed: ${message}`)
    process.exitCode = 1
  })
}
