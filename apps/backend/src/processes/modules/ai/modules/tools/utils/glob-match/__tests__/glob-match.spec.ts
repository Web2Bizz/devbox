/**
 * Glob matcher util checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/tools/utils/glob-match/__tests__/glob-match.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers the four matcher rules the tools rely on: `**` crosses `/`, `*`/`?`
 * stay inside one segment, a pattern without `/` matches the basename, a `./`
 * prefix is normalized and regex metacharacters are escaped literally.
 */
import assert from "node:assert/strict";
import { matchGlob } from "../glob-match.util";

type Check = { name: string; run: () => void };

const checks: Array<Check> = [
  {
    name: "** crosses path separators",
    run: () => {
      assert.equal(matchGlob("src/**/*.ts", "src/a/b/c.ts"), true);
      assert.equal(matchGlob("**/*.ts", "a/b/c.ts"), true);
      assert.equal(matchGlob("src/**/c.ts", "src/c.ts"), true);
    },
  },
  {
    name: "* stays inside one segment",
    run: () => {
      assert.equal(matchGlob("src/*.ts", "src/a.ts"), true);
      assert.equal(matchGlob("src/*.ts", "src/nested/a.ts"), false);
      assert.equal(matchGlob("src/*/a.ts", "src/nested/a.ts"), true);
    },
  },
  {
    name: "? matches exactly one non-separator character",
    run: () => {
      assert.equal(matchGlob("src/?.ts", "src/a.ts"), true);
      assert.equal(matchGlob("src/?.ts", "src/ab.ts"), false);
      assert.equal(matchGlob("src/?.ts", "src//a.ts"), false);
    },
  },
  {
    name: "pattern without / matches the basename",
    run: () => {
      assert.equal(matchGlob("*.ts", "deep/nested/file.ts"), true);
      assert.equal(matchGlob("*.ts", "deep/nested/file.md"), false);
      assert.equal(matchGlob("file.ts", "deep/nested/file.ts"), true);
    },
  },
  {
    name: "./ prefix is normalized before matching",
    run: () => {
      assert.equal(matchGlob("./src/*.ts", "src/a.ts"), true);
      assert.equal(matchGlob("./src/*.ts", "src/nested/a.ts"), false);
    },
  },
  {
    name: "regex metacharacters are escaped literally",
    run: () => {
      assert.equal(matchGlob("a.b.ts", "a.b.ts"), true);
      assert.equal(matchGlob("a.b.ts", "axb.ts"), false);
      assert.equal(matchGlob("file(1).ts", "deep/file(1).ts"), true);
      assert.equal(matchGlob("a+b.ts", "a+b.ts"), true);
    },
  },
];

function main(): void {
  let failed = 0;
  for (const check of checks) {
    try {
      check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} glob-match checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} glob-match checks failed`);
  }
  console.log(`${checks.length}/${checks.length} glob-match checks passed`);
}

main();
