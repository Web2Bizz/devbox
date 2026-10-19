import { test } from "node:test"
import assert from "node:assert/strict"
import { lanConnectionIds, mergeSessionLists } from "./listed-session.ts"
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

test("merge tags origin, sorts by recency, caps after merge", () => {
  const out = mergeSessionLists(
    [
      { connectionId: "cloud", sessions: [session("a", 3), session("b", 1)] },
      { connectionId: "lan", sessions: [session("c", 5), session("d", 2)] },
    ],
    3,
  )
  assert.deepEqual(
    out.map((s) => [s.id, s.connectionId]),
    [
      ["c", "lan"],
      ["a", "cloud"],
      ["d", "lan"],
    ],
  )
})

test("merge tolerates empty and missing lists", () => {
  assert.deepEqual(mergeSessionLists([]), [])
  assert.deepEqual(mergeSessionLists([{ connectionId: "x", sessions: [] }]), [])
})

test("lanConnectionIds picks only LAN-marked entries", () => {
  assert.deepEqual(
    [...lanConnectionIds([{ id: "a" }, { id: "b", discoveredOnLan: true }, { id: "c", discoveredOnLan: false }])],
    ["b"],
  )
})
