/**
 * JevService ask-route checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/common/zen/__tests__/jev.service.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: System One choice 'ask' → {route:'ask', provider:'jev'};
 * heuristic fallback without a key: ask markers → 'ask', no markers →
 * 'unclear', domain markers still win over ask markers.
 */
import assert from "node:assert/strict";
import { JevService } from "../jev.service";

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

function noKeyService(entries: Array<LogEntry>): JevService {
  const keys = { findByUserId: async () => null };
  const crypto = { decrypt: () => "k", isActiveKeyId: () => true };
  const external = {
    fetchWithRetry: async () => {
      throw new Error("must not be called without a key");
    },
  };
  return new JevService(keys as never, crypto as never, external as never, fakeLogger(entries) as never);
}

function jevChoiceService(choice: string, confidence: number, entries: Array<LogEntry>): JevService {
  const keys = {
    findByUserId: async () => ({ encryptedKey: "e", iv: "i", keyId: "k1" }),
  };
  const crypto = { decrypt: () => "plain", isActiveKeyId: () => true };
  const external = {
    fetchWithRetry: async () => ({
      ok: true,
      json: async () => ({ answers: { route: { choice, confidence } } }),
    }),
  };
  return new JevService(keys as never, crypto as never, external as never, fakeLogger(entries) as never);
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "jev choice ask → route=ask provider=jev",
    run: async () => {
      const entries: Array<LogEntry> = [];
      const svc = jevChoiceService("ask", 0.9, entries);
      const res = await svc.classify("объясни, что это такое", "u1", { correlationId: "cid-1" });
      assert.equal(res.route, "ask");
      assert.equal(res.provider, "jev");
      assert.equal(res.confidence, 0.9);
    },
  },
  {
    name: "heuristic without key: ask markers → ask",
    run: async () => {
      const entries: Array<LogEntry> = [];
      const svc = noKeyService(entries);
      const res = await svc.classify("подскажи, как это работает", "u1", { correlationId: "cid-2" });
      assert.equal(res.route, "ask");
      assert.equal(res.provider, "heuristic");
    },
  },
  {
    name: "heuristic without key: no markers → unclear",
    run: async () => {
      const entries: Array<LogEntry> = [];
      const svc = noKeyService(entries);
      const res = await svc.classify("zxqw fpv 12345", "u1", { correlationId: "cid-3" });
      assert.equal(res.route, "unclear");
      assert.equal(res.provider, "heuristic");
    },
  },
  {
    name: "heuristic: domain markers win over ask markers",
    run: async () => {
      const entries: Array<LogEntry> = [];
      const svc = noKeyService(entries);
      const res = await svc.classify("объясни контроллер Nest", "u1", { correlationId: "cid-4" });
      assert.equal(res.route, "backend");
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
    console.error(`${failed}/${checks.length} jev ask-route checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} jev ask-route checks failed`);
  }
  console.log(`${checks.length}/${checks.length} jev ask-route checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`jev ask-route checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
