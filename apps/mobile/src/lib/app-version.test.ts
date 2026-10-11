import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

// The user-visible version is single-sourced from the root package.json:
// bumping it (+ `node scripts/sync-version.mjs` for the native shells) is
// the whole release procedure (see AGENTS.md "Version bump").
//
// Runtime code must read it through exactly one module — src/lib/app-version
// (which Metro bundles via a JSON import that node's test runner can't
// resolve, so this invariant is checked statically, same pattern as
// persisted-keys.test.ts). A second direct `package.json` import in app/
// or src/ would silently fork the source of truth on the next bump.
const ROOT = path.join(import.meta.dirname, "..", "..")
const APP_DIRS = [path.join(ROOT, "app"), path.join(ROOT, "src")]
const OWNER = path.join("src", "lib", "app-version.ts")

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!/\.tsx?$/.test(entry.name)) return []
    if (entry.name.includes(".test.")) return []
    return [full]
  })
}

test("package.json carries a dotted release version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: string }
  assert.match(pkg.version ?? "", /^\d+\.\d+\.\d+$/, "expected a dotted release version, not a placeholder")
})

test("app-version.ts re-exports the package.json version", () => {
  const code = fs.readFileSync(path.join(ROOT, OWNER), "utf8")
  assert.match(code, /from "\.\.\/\.\.\/package\.json"/, "must import the root package.json")
  assert.match(code, /export const APP_VERSION/, "must export APP_VERSION")
})

test("no other runtime file imports package.json directly", () => {
  const offenders: string[] = []
  for (const dir of APP_DIRS) {
    for (const file of sourceFiles(dir)) {
      if (path.relative(ROOT, file) === OWNER) continue
      const code = fs.readFileSync(file, "utf8")
      if (/(?:import|require)\([^)]*package\.json|from\s+["'][^"']*package\.json["']/.test(code)) {
        offenders.push(path.relative(ROOT, file))
      }
    }
  }
  assert.deepEqual(offenders, [], "route version reads through src/lib/app-version.ts instead:\n" + offenders.join("\n"))
})
