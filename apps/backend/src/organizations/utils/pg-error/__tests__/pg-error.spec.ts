/**
 * pg-error util checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/organizations/utils/pg-error/__tests__/pg-error.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the drizzle wrapping shape: SQLSTATE on the error itself, on
 * `.cause`, and on a nested `.cause`; message fallbacks ("duplicate key",
 * "foreign key"); false for unrelated errors.
 */
import assert from "node:assert/strict";
import { isPgForeignKeyViolation, isPgUniqueViolation } from "../pg-error.util";

function wrap(code: string, depth: number): unknown {
  let err: unknown = Object.assign(new Error(`wrapped-${code}`), { code });
  for (let i = 0; i < depth; i++) {
    err = Object.assign(new Error(`level-${i}`), { cause: err });
  }
  return err;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "SQLSTATE 23505 → unique violation (error, .cause, nested .cause)",
    run: () => {
      assert.ok(isPgUniqueViolation(wrap("23505", 0)), "code on the error");
      assert.ok(isPgUniqueViolation(wrap("23505", 1)), "code on .cause");
      assert.ok(isPgUniqueViolation(wrap("23505", 3)), "code on nested .cause");
      assert.ok(!isPgForeignKeyViolation(wrap("23505", 2)));
    },
  },
  {
    name: "SQLSTATE 23503 → foreign key violation (error, .cause, nested .cause)",
    run: () => {
      assert.ok(isPgForeignKeyViolation(wrap("23503", 0)), "code on the error");
      assert.ok(isPgForeignKeyViolation(wrap("23503", 1)), "code on .cause");
      assert.ok(isPgForeignKeyViolation(wrap("23503", 3)), "code on nested .cause");
      assert.ok(!isPgUniqueViolation(wrap("23503", 2)));
    },
  },
  {
    name: "message fallbacks: 'duplicate key' / 'foreign key'",
    run: () => {
      assert.ok(isPgUniqueViolation(new Error('duplicate key value violates unique constraint "x"')));
      assert.ok(isPgForeignKeyViolation(new Error("update or delete violates foreign key constraint")));
    },
  },
  {
    name: "false for unrelated errors and non-error values",
    run: () => {
      assert.ok(!isPgUniqueViolation(new Error("connection refused")));
      assert.ok(!isPgForeignKeyViolation(new Error("connection refused")));
      assert.ok(!isPgUniqueViolation(Object.assign(new Error("boom"), { code: "42P01" })));
      assert.ok(!isPgForeignKeyViolation(Object.assign(new Error("boom"), { code: "42P01" })));
      assert.ok(!isPgUniqueViolation(undefined));
      assert.ok(!isPgForeignKeyViolation(null));
      assert.ok(!isPgUniqueViolation("plain string"));
      assert.ok(!isPgForeignKeyViolation("plain string"));
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
    console.error(`${failed}/${checks.length} pg-error checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} pg-error checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} pg-error checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`pg-error checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
