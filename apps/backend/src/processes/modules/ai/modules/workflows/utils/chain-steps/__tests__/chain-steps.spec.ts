import assert from "node:assert/strict";
import {
  AUTO_FILES_REQUIREMENT,
  buildDecomposePrompt,
  buildStepPrompt,
  buildSynthesizePrompt,
  CONTEXT_LIMIT,
  MAX_STEPS,
  parseSteps,
} from "../chain-steps.util";

/**
 * chain-steps unit checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/workflows/utils/chain-steps/__tests__/chain-steps.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: parseSteps numbering/empty/cap/hostile, AUTO_FILES_REQUIREMENT text,
 * every prompt builder demands files in workspace.
 */

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

describe("chain-steps", () => {
  it("caps steps at MAX_STEPS and drops empties", () => {
    assert.equal(MAX_STEPS, 5);
    assert.deepEqual(parseSteps("1. Создай hello.js\n2) Создай package.json\nболтовня"), [
      "Создай hello.js",
      "Создай package.json",
    ]);
    assert.deepEqual(parseSteps("только текст без шагов"), []);
    assert.deepEqual(parseSteps("1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g"), [
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("drops boundary noise and throws on hostile input (no silent [])", () => {
    assert.equal(CONTEXT_LIMIT, 6000);
    assert.deepEqual(parseSteps(""), []);
    assert.deepEqual(parseSteps("1.   \n2.    \n- just dash\n* star\n1: colon-no"), []);
    assert.throws(() => parseSteps(null as unknown as string));
    assert.throws(() => parseSteps(undefined as unknown as string));
  });

  it("keeps AUTO_FILES_REQUIREMENT as the shared file-result guard", () => {
    assert.ok(AUTO_FILES_REQUIREMENT.includes("файлы в workspace проекта"));
    assert.ok(AUTO_FILES_REQUIREMENT.includes("без файлов запрещён"));
  });

  it("demands files in every chain prompt", () => {
    const decompose: string = buildDecomposePrompt("сделай hello");
    const step: string = buildStepPrompt("сделай hello", 1, 2, "создай файл", "контекст");
    const synthesize: string = buildSynthesizePrompt("сделай hello", "результат");
    for (const prompt of [decompose, step, synthesize]) {
      assert.ok(prompt.includes("workspace") && prompt.includes("файл"));
    }
    assert.ok(decompose.includes("сделай hello"));
    assert.ok(step.includes("Шаг 1/2"));
    assert.ok(synthesize.includes("Собери итоговый ответ"));
  });
});

for (const item of cases) {
  item.run();
  console.log(`ok ${item.name}`);
}
console.log(`done ${cases.length}`);
