/**
 * uuid-v7 util checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist (same constraint as the domain *.e2e.ts runners):
 *   `bun run build && bun dist/organizations/utils/uuid-v7/__tests__/uuid-v7.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the UTIL-03 contract: RFC 9562 v7 shape (version 7 + variant 8-b),
 * lexicographic time ordering, and rejection of v4 / garbage / base64url.
 * Never logs secrets (tokens only as opaque values).
 */
import assert from "node:assert/strict";
import { isUuidV7, randomUuidV7 } from "../uuid-v7.util";

const V4 = "123e4567-e89b-12d3-a456-426614174001";

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "randomUuidV7 emits RFC 9562 v7 ids (version 7, variant 8-b, time-ordered)",
    run: () => {
      const a = randomUuidV7(Date.parse("2026-10-20T00:00:00.000Z"));
      const b = randomUuidV7(Date.parse("2026-10-20T00:00:01.000Z"));
      assert.ok(isUuidV7(a), `expected v7, got ${a}`);
      assert.ok(isUuidV7(b), `expected v7, got ${b}`);
      assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      // Time-ordered: later timestamp sorts later lexicographically.
      assert.ok(a < b, `expected ${a} < ${b}`);
      assert.ok(!isUuidV7(V4), "v4 must not pass as v7");
      assert.ok(!isUuidV7("no-such-token"), "garbage must not pass as v7");
      assert.ok(!isUuidV7("a".repeat(44)), "base64url must not pass as v7");
    },
  },
  {
    name: "isUuidV7 accepts a generated v7 id",
    run: () => {
      const id = randomUuidV7();
      assert.ok(isUuidV7(id), `expected generated v7 to pass, got ${id}`);
      assert.equal(id.length, 36);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} uuid-v7 checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} uuid-v7 checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} uuid-v7 checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`uuid-v7 checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
