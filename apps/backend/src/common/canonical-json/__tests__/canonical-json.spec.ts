/**
 * canonicalJson unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the other runners):
 *   `bun run build && bun dist/common/canonical-json/__tests__/canonical-json.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the hash-input projection:
 * - object key order never changes the output (jsonb round-trip safety);
 * - nested objects are canonicalized recursively;
 * - arrays keep their order;
 * - Date → ISO-8601 string;
 * - undefined keys are skipped / undefined array items become null;
 * - primitives and bigint are encoded deterministically.
 */
import assert from 'node:assert/strict';
import { canonicalJson } from '..';

const checks: Array<{ name: string; run: () => void }> = [
  {
    name: 'different object key order → identical output',
    run: () => {
      assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
      assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    },
  },
  {
    name: 'nested objects are canonicalized recursively',
    run: () => {
      const left = canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } });
      const right = canonicalJson({ outer: { a: { b: 3, y: 2 }, z: 1 } });
      assert.equal(left, right);
      assert.equal(left, '{"outer":{"a":{"b":3,"y":2},"z":1}}');
    },
  },
  {
    name: 'arrays keep their order',
    run: () => {
      assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
      assert.equal(canonicalJson([1, 2]), '[1,2]');
    },
  },
  {
    name: 'Date → ISO-8601 string',
    run: () => {
      const date = new Date('2026-01-02T03:04:05.000Z');
      assert.equal(canonicalJson(date), '"2026-01-02T03:04:05.000Z"');
      assert.equal(canonicalJson({ at: date }), '{"at":"2026-01-02T03:04:05.000Z"}');
    },
  },
  {
    name: 'undefined object keys are skipped',
    run: () => {
      assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
    },
  },
  {
    name: 'undefined array items become null',
    run: () => {
      assert.equal(canonicalJson([undefined, 1]), '[null,1]');
    },
  },
  {
    name: 'primitives pass through deterministically',
    run: () => {
      assert.equal(canonicalJson(null), 'null');
      assert.equal(canonicalJson('text'), '"text"');
      assert.equal(canonicalJson(42), '42');
      assert.equal(canonicalJson(true), 'true');
      assert.equal(canonicalJson(false), 'false');
    },
  },
  {
    name: 'bigint → decimal string',
    run: () => {
      assert.equal(canonicalJson(42n), '"42"');
      assert.equal(canonicalJson({ seq: 7n }), '{"seq":"7"}');
    },
  },
];

function main(): void {
  let failed = 0;
  for (const c of checks) {
    try {
      c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} canonical-json checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} canonical-json checks failed`);
  }
  console.log(`${checks.length}/${checks.length} canonical-json checks passed`);
}

main();
