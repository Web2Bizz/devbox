/**
 * Install-state util checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/organizations/modules/projects/modules/github/utils/app-state/__tests__/app-state.spec.js`
 *
 * Covers the signed state contract:
 * - sign/verify roundtrip keeps the user id and expiry;
 * - a state signed with another secret is rejected;
 * - a tampered payload under the original signature is rejected;
 * - an expired state is reported as `expired`;
 * - states for different users stay bound to their user id;
 * - malformed input is reported as `invalid`.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  APP_STATE_TTL_MS,
  signAppState,
  verifyAppState,
} from "../app-state.util";

const SECRET = "state-spec-secret-not-real";
const NOW = Date.parse("2025-01-01T00:00:00.000Z");

type Case = { name: string; run: () => Promise<void> | void };

const cases: Case[] = [];

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name, run });
}

function tamperEncoded(state: string): string {
  const [encoded, signature] = state.split(".");
  const payload = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as { userId: string; exp: number; iat?: number };
  const forged = Buffer.from(
    JSON.stringify({ ...payload, userId: "mallory" }),
    "utf8",
  ).toString("base64url");
  return `${forged}.${signature}`;
}

it("signs and verifies a state for the same user", () => {
  const state = signAppState("alice", SECRET, { nowMs: NOW });
  const result = verifyAppState(state, SECRET, { nowMs: NOW + 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.userId, "alice");
  assert.equal(result.payload.iat, NOW);
  assert.equal(result.payload.exp, NOW + APP_STATE_TTL_MS);
});

it("rejects a state signed for another domain prefix", () => {
  const payload = {
    userId: "alice",
    iat: NOW,
    exp: NOW + APP_STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", SECRET)
    .update(encoded, "utf8")
    .digest("base64url");
  assert.deepEqual(
    verifyAppState(`${encoded}.${signature}`, SECRET, { nowMs: NOW + 1 }),
    { ok: false, reason: "invalid" },
  );
});

it("rejects a state signed with another secret", () => {
  const state = signAppState("alice", SECRET, { nowMs: NOW });
  assert.deepEqual(verifyAppState(state, "other-secret", { nowMs: NOW }), {
    ok: false,
    reason: "invalid",
  });
});

it("rejects a payload swapped under the original signature", () => {
  const state = signAppState("alice", SECRET, { nowMs: NOW });
  assert.deepEqual(verifyAppState(tamperEncoded(state), SECRET, { nowMs: NOW }), {
    ok: false,
    reason: "invalid",
  });
});

it("reports an expired state as expired", () => {
  const state = signAppState("alice", SECRET, { nowMs: NOW, ttlMs: 1_000 });
  assert.deepEqual(
    verifyAppState(state, SECRET, { nowMs: NOW + 1_000 }),
    { ok: false, reason: "expired" },
  );
});

it("keeps states for different users distinct", () => {
  const alice = verifyAppState(
    signAppState("alice", SECRET, { nowMs: NOW }),
    SECRET,
    { nowMs: NOW },
  );
  const bob = verifyAppState(
    signAppState("bob", SECRET, { nowMs: NOW }),
    SECRET,
    { nowMs: NOW },
  );
  assert.equal(alice.ok, true);
  assert.equal(bob.ok, true);
  if (!alice.ok || !bob.ok) return;
  assert.equal(alice.payload.userId, "alice");
  assert.equal(bob.payload.userId, "bob");
});

it("rejects missing, empty and malformed states", () => {
  for (const state of [
    undefined,
    null,
    "",
    "not-a-state",
    "only-one-segment",
    ".signature",
    "payload.",
    "payload.signature.extra",
  ]) {
    assert.deepEqual(
      verifyAppState(state, SECRET, { nowMs: NOW }),
      { ok: false, reason: "invalid" },
      `expected invalid for ${String(state)}`,
    );
  }
  assert.deepEqual(
    verifyAppState(signAppState("alice", SECRET, { nowMs: NOW }), "", { nowMs: NOW }),
    { ok: false, reason: "invalid" },
  );
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`app-state checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
