import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCatalogResponse } from "./catalog-parse.ts"

const agents = [
  { name: "build", mode: "primary", hidden: false, options: {} },
  { name: "secret", mode: "primary", hidden: true, options: {} },
]

test("hidden agents are filtered out, garbage in -> empty lists", () => {
  const out = parseCatalogResponse(agents, [{ name: "c", hints: [], template: "" }], null)
  assert.deepEqual(
    out.agents.map((a) => a.name),
    ["build"],
  )
  assert.equal(out.commands.length, 1)
  assert.deepEqual(out.providers, [])
  assert.deepEqual(out.defaults, {})
  const empty = parseCatalogResponse(undefined, "nope", undefined)
  assert.deepEqual(empty.agents, [])
  assert.deepEqual(empty.commands, [])
})

test("only connected providers with non-deprecated, non-empty models survive", () => {
  const raw = {
    connected: ["openai", "empty", "ghost"],
    default: { openai: "gpt-4o" },
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          a: { id: "gpt-4o", name: "GPT-4o", reasoning: false, attachment: true, tool_call: true, limit: { context: 1, output: 1 } },
          b: { id: "old", name: "Old", status: "deprecated" },
        },
      },
      { id: "empty", models: {} },
      { id: "disconnected", models: { x: { id: "x" } } },
    ],
  }
  const out = parseCatalogResponse([], [], raw)
  assert.deepEqual(
    out.providers.map((p) => p.id),
    ["openai"],
  )
  assert.deepEqual(
    out.providers[0].models.map((m) => m.id),
    ["gpt-4o"],
  )
  assert.deepEqual(out.defaults, { openai: "gpt-4o" })
})
