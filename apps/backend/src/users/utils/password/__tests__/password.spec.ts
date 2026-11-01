/**
 * Password util checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/users/utils/password/__tests__/password.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers argon2id round-trip (hash → verify true, wrong password → false) and a
 * driver failure → false with the fixed error event (sanitized cause at debug
 * only; neither the password nor the hash ever reaches the logs).
 * Needs the bun runtime (`Bun.password`) — no live Postgres.
 */
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, type PasswordLogger } from "../password.util";

type LogEntry = { level: string; message: string };

type BunPasswordApi = {
  hash: (password: string, options?: Record<string, unknown>) => Promise<string>;
  verify: (password: string, hash: string) => Promise<boolean>;
};

type BunRuntime = { password?: BunPasswordApi };

const PASSWORD = "s3cret-p4ss";
const STORED_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$c3RvcmVkLXNhbHQ$c3RvcmVkLWhhc2g";

function captureLogger(entries: Array<LogEntry>) {
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
  } as unknown as PasswordLogger;
}

/** The bun global is writable — swap only `Bun.password` and restore it after. */
function stubPasswordApi(stub: BunPasswordApi): () => void {
  const runtime = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  assert.ok(runtime, "the bun runtime (Bun.password) is required");
  const original = runtime.password;
  runtime.password = stub;
  return () => {
    runtime.password = original;
  };
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "hash → verify round-trip: argon2id hash verifies, wrong password does not",
    run: async () => {
      const entries: Array<LogEntry> = [];
      const logger = captureLogger(entries);
      const passwordHash = await hashPassword(PASSWORD, logger);
      assert.match(passwordHash, /^\$argon2id\$/);
      assert.equal(await verifyPassword(PASSWORD, passwordHash, logger), true);
      assert.equal(await verifyPassword("wrong-password", passwordHash, logger), false);
      assert.ok(
        entries.some((entry) => entry.message.includes("[auth] password hashed")),
      );
      assert.ok(!entries.some((entry) => entry.message.includes(PASSWORD)));
      assert.ok(!entries.some((entry) => entry.message.includes(passwordHash)));
    },
  },
  {
    name: "driver failure → false, fixed error event, no password/hash in logs",
    run: async () => {
      const entries: Array<LogEntry> = [];
      const restore = stubPasswordApi({
        hash: async () => {
          throw new Error("hash driver failure");
        },
        verify: async () => {
          throw new Error("verify driver failure");
        },
      });
      try {
        assert.equal(
          await verifyPassword(PASSWORD, STORED_HASH, captureLogger(entries), "cid-1"),
          false,
        );
      } finally {
        restore();
      }
      const errorEntry = entries.find((entry) => entry.level === "error");
      assert.ok(errorEntry, "driver failure must log an error event");
      assert.equal(errorEntry?.message, "[auth] password verify failed");
      const logged = entries.map((entry) => entry.message).join("\n");
      assert.ok(!logged.includes(PASSWORD), "password must never be logged");
      assert.ok(!logged.includes(STORED_HASH), "hash must never be logged");
      assert.ok(
        entries.some(
          (entry) =>
            entry.level === "debug" &&
            entry.message.includes("verify driver failure"),
        ),
        "sanitized cause detail goes to debug",
      );
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} password checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} password checks failed`);
  }
  console.log(`${checks.length}/${checks.length} password checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`password checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
