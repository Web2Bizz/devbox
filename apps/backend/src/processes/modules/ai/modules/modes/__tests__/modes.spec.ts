import assert from "node:assert/strict";
import { ModesService } from "../modes.service";

/**
 * ModesService unit checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/modes/__tests__/modes.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: ask → single-answer, auto → routed-chain, unknown id throws the
 * honest 404 (never falls back), listModes fixed pair.
 */

type LogEntry = { level: string; message: string };

function fakeLogger(entries: Array<LogEntry>): unknown {
  const record = (level: string) => (message: unknown): void => {
    entries.push({ level, message: String(message) });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    log: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
  };
}

type Case = { name: string; run: () => void };
const cases: Array<Case> = [];
let suite: string = "";

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}

function it(name: string, run: () => void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

describe("ModesService", () => {
  it("maps ask to the single-answer workflow", () => {
    const service: ModesService = new ModesService(fakeLogger([]) as never);
    const selection = service.resolve("ask", "cid-1");
    assert.equal(selection.mode, "ask");
    assert.equal(selection.workflow, "single-answer");
  });

  it("maps auto to the routed-chain workflow", () => {
    const service: ModesService = new ModesService(fakeLogger([]) as never);
    const selection = service.resolve("auto");
    assert.equal(selection.mode, "auto");
    assert.equal(selection.workflow, "routed-chain");
  });

  it("throws honest 404 for unknown ids (never falls back)", () => {
    const service: ModesService = new ModesService(fakeLogger([]) as never);
    assert.throws(() => service.resolve("nope"), /Agent 'nope' not found/);
    assert.throws(() => service.resolve("backend"), /Agent 'backend' not found/);
  });

  it("lists the fixed mode pair", () => {
    const service: ModesService = new ModesService(fakeLogger([]) as never);
    const modes = service.listModes();
    assert.deepEqual(
      modes.map((mode) => mode.mode),
      ["ask", "auto"],
    );
    assert.deepEqual(
      modes.map((mode) => mode.workflow),
      ["single-answer", "routed-chain"],
    );
  });
});

for (const item of cases) {
  item.run();
  console.log(`ok ${item.name}`);
}
console.log(`done ${cases.length}`);
