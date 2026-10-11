#!/usr/bin/env node
// Version auto-increment, ported from web2bizz/ui scripts/bump-version.js
// (decimal engine). Only package.json is written here — native release
// metadata (app.json version/versionCode, gradle versionName, changelogs)
// is brought in lockstep afterwards by scripts/bump-release-meta.mjs.
//
// Two modes:
//   default (dev): carry-on-9 patch bump, exactly like web2bizz/ui:
//     0.4.15 → 0.4.16 … 0.4.19 → 0.5.0 → … 0.9.9 → 1.0.0
//     (minor >9 just increments: 0.25.9 → 0.26.0, no major carry)
//   --major (main merges): major+1 with minor/patch reset: 0.4.15 → 1.0.0
//     versionCode is NEVER reset — it stays monotonic in app.json (Play /
//     F-Droid key upgrades off it); only the version NAME resets.
//
// Usage:
//   node scripts/bump-version.mjs                 # dev bump, writes package.json
//   node scripts/bump-version.mjs --major         # major bump, writes package.json
//   node scripts/bump-version.mjs --dry-run       # print next version only
//   node scripts/bump-version.mjs --major --dry-run
//   node scripts/bump-version.mjs --file ./package.json
//   node scripts/bump-version.mjs --version 0.4.19 --dry-run
//   node scripts/bump-version.mjs --help
//
// For CI: node scripts/bump-version.mjs && node -p "require('./package.json').version"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const CARRY = 9

export function parseVersion(vStr) {
  const base = String(vStr).replace(/^v/, "").split("-")[0].split("+")[0]
  const match = base.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error(`Invalid semver '${vStr}' (expected X.Y.Z)`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

// web2bizz/ui decimal bump, verbatim semantics:
//   patch<9 → patch+1; patch==9 → minor+1, patch=0;
//   overflow at minor==9 carries to major (0.9.9 → 1.0.0);
//   minor>9 just increments (0.25.9 → 0.26.0).
export function nextDevVersion(current) {
  const { major, minor, patch } = parseVersion(current)
  if (patch < CARRY) return `${major}.${minor}.${patch + 1}`
  if (minor === CARRY) return `${major + 1}.0.0`
  return `${major}.${minor + 1}.0`
}

// Main-merge bump: major+1, minor and patch reset.
export function nextMajorVersion(current) {
  const { major } = parseVersion(current)
  return `${major + 1}.0.0`
}

function printHelp() {
  console.log(
    `
bump-version.mjs — automatic version bump in package.json (port of web2bizz/ui)

  default        carry-on-9 patch bump (dev): 0.4.15 → 0.4.16 … 0.4.19 → 0.5.0
  --major        major bump with reset (main): 0.4.15 → 1.0.0

Options:
  --major            bump major, reset minor/patch
  --file <path>      path to package.json (default ./package.json)
  --version <ver>    bump this version instead of reading the file
  --dry-run          print next version only, don't write
  --help, -h         this help
`.trim(),
  )
}

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { major: false, file: "package.json", versionOverride: null, dryRun: false, help: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--major") opts.major = true
    else if (a === "--dry-run") opts.dryRun = true
    else if (a === "--help" || a === "-h") opts.help = true
    else if (a === "--file") {
      opts.file = args[++i]
      if (!opts.file) throw new Error("--file requires a path")
    } else if (a === "--version") {
      opts.versionOverride = args[++i]
      if (!opts.versionOverride) throw new Error("--version requires a value")
    } else {
      console.error(`Unknown argument: ${a}`)
      printHelp()
      process.exit(1)
    }
  }
  return opts
}

async function run() {
  const opts = parseArgs()
  if (opts.help) {
    printHelp()
    return
  }
  const bump = opts.major ? nextMajorVersion : nextDevVersion
  const label = opts.major ? "major" : "dev"

  let current
  let pkg = null
  let pkgPath = null
  if (opts.versionOverride) {
    current = opts.versionOverride
  } else {
    pkgPath = path.resolve(process.cwd(), opts.file)
    const raw = await readFile(pkgPath, "utf8").catch(() => {
      console.error(`package.json not found: ${pkgPath}`)
      process.exit(1)
    })
    pkg = JSON.parse(raw)
    if (!pkg.version) {
      console.error("Field version is missing in package.json")
      process.exit(1)
    }
    current = pkg.version
  }

  const next = bump(current)

  if (!opts.dryRun) {
    const targetPath = pkgPath ?? path.resolve(process.cwd(), opts.file)
    const target = pkg ?? JSON.parse(await readFile(targetPath, "utf8"))
    target.version = next
    await writeFile(targetPath, JSON.stringify(target, null, 2) + "\n", "utf8")
  }

  // stdout for CI capture
  console.log(next)
  console.error(`[${label}] ${current} → ${next}${opts.dryRun ? " (dry-run)" : ""}`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
if (isMain) {
  run().catch((e) => {
    console.error(`${e.message}`)
    process.exit(1)
  })
}
