import assert from "node:assert/strict";
import { AgentsRegistryService } from "../agents-registry.service";
import type { AgentDefinition } from "../agents-registry.types";

/**
 * Registry contract: picker lists only visible primary agents, resolve never
 * throws and an unknown id falls back to the default ask agent. Registration
 * is explicit (the executors register at boot through AgentsBootstrapService),
 * so the spec registers only the definitions it exercises.
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

function definition(
  id: string,
  name: string,
  hidden: boolean,
  mode: AgentDefinition["mode"],
): AgentDefinition {
  return { id, name, description: `${name} agent`, hidden, mode };
}

function registry(): AgentsRegistryService {
  const service: AgentsRegistryService = new AgentsRegistryService();
  service.registerAll([
    definition("ask", "Ask", false, "primary"),
    definition("auto", "Auto", false, "primary"),
    definition("backend", "Backend", true, "subagent"),
    definition("frontend", "Frontend", true, "subagent"),
    definition("fullstack", "Fullstack", true, "subagent"),
  ]);
  return service;
}

describe("AgentsRegistryService", () => {
  it("lists only visible primary agents", () => {
    assert.deepEqual(
      registry()
        .list()
        .map((agent) => agent.id),
      ["ask", "auto"],
    );
  });

  it("keeps hidden executors registered but out of the picker", () => {
    const service: AgentsRegistryService = registry();
    assert.equal(service.all().length, 5);
    assert.equal(service.resolve("backend").mode, "subagent");
    assert.equal(service.resolve("backend").hidden, true);
  });

  it("falls back to ask for absent or unknown ids (never throws)", () => {
    const service: AgentsRegistryService = registry();
    assert.equal(service.resolve().id, "ask");
    assert.equal(service.resolve("nope").id, "ask");
    assert.equal(service.select("nope").id, "ask");
  });

  it("resolves a known id as itself", () => {
    assert.equal(registry().resolve("auto").id, "auto");
  });

  it("keeps registration order in names()", () => {
    assert.deepEqual(registry().names(), [
      "ask",
      "auto",
      "backend",
      "frontend",
      "fullstack",
    ]);
  });

  it("last registration wins on a duplicate id", () => {
    const service: AgentsRegistryService = new AgentsRegistryService();
    service.register(definition("ask", "Ask", false, "primary"));
    service.register({ ...definition("ask", "Ask", false, "primary"), description: "second" });
    assert.equal(service.all().length, 1);
    assert.equal(service.resolve("ask").description, "second");
  });
});

for (const item of cases) {
  item.run();
  console.log(`ok ${item.name}`);
}
console.log(`done ${cases.length}`);
