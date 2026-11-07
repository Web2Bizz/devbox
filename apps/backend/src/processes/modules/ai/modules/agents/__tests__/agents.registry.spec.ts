import assert from "node:assert/strict";
import { AgentRegistry } from "../agents.registry";

/**
 * Registry contract: picker lists only visible primary agents, resolve never
 * throws and an unknown id falls back to the default ask agent.
 */
type Case = { name: string; run: () => void };
const cases: Array<Case> = [];
let suite = "";

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}

function it(name: string, run: () => void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

function stub(id: string, name: string) {
  return { id, name, description: `${name} agent` } as never;
}

const registry = new AgentRegistry(
  stub("ask", "Ask"),
  stub("auto", "Auto"),
  stub("backend", "Backend"),
  stub("frontend", "Frontend"),
  stub("fullstack", "Fullstack"),
);

describe("AgentRegistry", () => {
  it("lists only visible primary agents", () => {
    assert.deepEqual(
      registry.list().map((agent) => agent.id),
      ["ask", "auto"],
    );
  });

  it("keeps hidden executors registered but out of the picker", () => {
    assert.equal(registry.all().length, 5);
    assert.equal(registry.resolve("backend").mode, "subagent");
    assert.equal(registry.resolve("backend").hidden, true);
  });

  it("falls back to ask for absent or unknown ids (never throws)", () => {
    assert.equal(registry.resolve().id, "ask");
    assert.equal(registry.resolve("nope").id, "ask");
    assert.equal(registry.select("nope").id, "ask");
  });

  it("resolves a known id as itself", () => {
    assert.equal(registry.resolve("auto").id, "auto");
  });
});

for (const item of cases) {
  item.run();
  console.log(`ok ${item.name}`);
}
console.log(`done ${cases.length}`);
