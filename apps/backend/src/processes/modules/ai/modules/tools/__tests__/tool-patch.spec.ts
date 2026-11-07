import assert from "node:assert/strict";
import { applyHunks, parseUnifiedPatch } from "../patch.tool";

/**
 * Pure unified-diff parser/applier: sections split per file, hunks apply with
 * strict context (mismatch never silently corrupts the file).
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

const PATCH = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
].join("\n");

describe("parseUnifiedPatch", () => {
  it("splits per-file sections and reads the new path", () => {
    const sections = parseUnifiedPatch(PATCH);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.file, "src/a.ts");
    assert.equal(sections[0]?.hunks.length, 1);
  });

  it("ignores a diff without hunks", () => {
    assert.equal(parseUnifiedPatch("--- a/x\n+++ b/x\n").length, 0);
  });
});

describe("applyHunks", () => {
  it("applies a replacement hunk", () => {
    const section = parseUnifiedPatch(PATCH)[0];
    assert.ok(section);
    const out = applyHunks("const a = 1;\nconst b = 2;\nconst c = 4;", section.hunks);
    assert.equal(out, "const a = 1;\nconst b = 3;\nconst c = 4;");
  });

  it("rejects a context mismatch", () => {
    const section = parseUnifiedPatch(PATCH)[0];
    assert.ok(section);
    assert.throws(() => applyHunks("const a = 1;\nconst b = 9;\nconst c = 4;", section.hunks), /context mismatch/);
  });
});

for (const item of cases) {
  item.run();
  console.log(`ok ${item.name}`);
}
console.log(`done ${cases.length}`);
