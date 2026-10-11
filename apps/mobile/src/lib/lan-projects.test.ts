import { test } from "node:test"
import assert from "node:assert/strict"
import { groupProjects } from "./session-grouping.ts"
import { lanConnectionIds, mergeSessionLists } from "./listed-session.ts"
import { buildManualLanUrl } from "./lan-manual.ts"
import { queryKeys } from "./query-keys.ts"
import type { Session } from "./sdk.ts"

const session = (id: string, updated: number, directory = "/proj"): Session => ({
  id,
  slug: id,
  projectID: "p",
  directory,
  title: id,
  version: "1",
  time: { created: 1, updated },
})

test("groupProjects: identical path on three servers stays three cards", () => {
  const items = [
    { id: "1", directory: "/srv/app", connectionId: "cloud" },
    { id: "2", directory: "/srv/app", connectionId: "lan-1" },
    { id: "3", directory: "/srv/app", connectionId: "lan-2" },
  ]
  const groups = groupProjects(items)
  assert.equal(groups.length, 3)
  assert.deepEqual(
    groups.map((g) => g.key),
    ["cloud::/srv/app", "lan-1::/srv/app", "lan-2::/srv/app"],
  )
  for (const g of groups) assert.equal(g.items.length, 1)
})

test("groupProjects: same connection + same path still merges into one card", () => {
  const groups = groupProjects([
    { id: "1", directory: "/a", connectionId: "lan" },
    { id: "2", directory: "/a", connectionId: "lan" },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, "lan::/a")
  assert.equal(groups[0].items.length, 2)
})

test("lanConnectionIds: empty list yields empty set, unmarked ids excluded", () => {
  assert.equal(lanConnectionIds([]).size, 0)
  assert.deepEqual(
    [...lanConnectionIds([{ id: "a" }, { id: "b", discoveredOnLan: true }])],
    ["b"],
  )
})

test("mergeSessionLists: same session id on two servers kept with own origin", () => {
  const out = mergeSessionLists([
    { connectionId: "cloud", sessions: [session("s1", 10, "/app")] },
    { connectionId: "lan", sessions: [session("s1", 9, "/app")] },
  ])
  assert.equal(out.length, 2)
  assert.deepEqual(
    out.map((s) => s.connectionId),
    ["cloud", "lan"],
  )
})

test("mergeSessionLists: hand-added LAN session lands in the merged snapshot", () => {
  const out = mergeSessionLists([
    { connectionId: "cloud", sessions: [session("old", 1, "/cloud-proj")] },
    { connectionId: "lan", sessions: [session("manual", 100, "/home/pi/app")] },
  ])
  assert.equal(out[0].id, "manual")
  assert.equal(out[0].connectionId, "lan")
  assert.equal(out[0].directory, "/home/pi/app")
})

test("serverProjectsFor: per-connection keys never collide with each other or the base", () => {
  assert.deepEqual([...queryKeys.serverProjectsFor("lan-1")], ["project", "list", "lan-1"])
  assert.notDeepEqual(
    [...queryKeys.serverProjectsFor("lan-1")],
    [...queryKeys.serverProjectsFor("lan-2")],
  )
  assert.notDeepEqual([...queryKeys.serverProjectsFor("lan-1")], [...queryKeys.serverProjects])
})

test("buildManualLanUrl: plain ip:port becomes an http URL", () => {
  assert.equal(buildManualLanUrl("192.168.1.23", "4096"), "http://192.168.1.23:4096")
})

test("buildManualLanUrl: empty port defaults to 4096, scheme paste passes through", () => {
  assert.equal(buildManualLanUrl("192.168.1.23", ""), "http://192.168.1.23:4096")
  assert.equal(buildManualLanUrl("http://192.168.1.23", "4096"), "http://192.168.1.23:4096")
  assert.equal(buildManualLanUrl("https://nas.local", "8443"), "https://nas.local:8443")
})

test("buildManualLanUrl: empty host returns null (caller falls back to hardcode)", () => {
  assert.equal(buildManualLanUrl("", "4096"), null)
  assert.equal(buildManualLanUrl("   ", ""), null)
})

test("buildManualLanUrl: bad port or host with spaces returns null", () => {
  assert.equal(buildManualLanUrl("192.168.1.23", "abc"), null)
  assert.equal(buildManualLanUrl("192.168.1.23", "0"), null)
  assert.equal(buildManualLanUrl("192.168.1.23", "70000"), null)
  assert.equal(buildManualLanUrl("my host", "4096"), null)
})
