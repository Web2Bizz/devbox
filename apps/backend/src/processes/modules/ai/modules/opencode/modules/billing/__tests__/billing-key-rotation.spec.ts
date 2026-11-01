/**
 * BillingService × CryptoService integration checks — self-contained runner
 * (plain node:assert): key integrity + lazy KEK re-wrap convergence.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/processes/modules/ai/modules/opencode/modules/billing/__tests__/billing-key-rotation.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Split out of common/crypto/__tests__/crypto.service.hardening.spec.ts:
 * these two checks exercise BillingService (ai scope), so they must not be
 * imported from common/. Assertions and messages are unchanged.
 *
 * Dummy KEKs only (≥32 chars, `...-not-real-...`), via process.env in-test,
 * never logged (roles + keyIds only, never values).
 */
import assert from "node:assert/strict";

// --- Dummy key material (test-only, never a real OpenCode API key) ---------
const ACTIVE_A = "hardening-test-kek-active-not-real-0123456789abcd";
const ACTIVE_B = "hardening-test-kek-rotated-not-real-0123456789abcd";
const PLAINTEXT = "hardening-test-opencode-api-key-not-real-0123456789";

function setKeyring(
  active: string,
  opts?: { activeId?: string; previous?: string; previousId?: string },
): void {
  process.env.OPENCODE_KEYS_ENCRYPTION_KEY = active;
  process.env.OPENCODE_KEYS_ACTIVE_KEY_ID = opts?.activeId ?? "v1";
  if (opts?.previous === undefined) {
    delete process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS;
  } else {
    process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS = opts.previous;
  }
  process.env.OPENCODE_KEYS_PREVIOUS_KEY_ID = opts?.previousId ?? "v0";
}

type SavedEnv = Record<string, string | undefined>;
function saveEnv(): SavedEnv {
  return {
    OPENCODE_KEYS_ENCRYPTION_KEY: process.env.OPENCODE_KEYS_ENCRYPTION_KEY,
    OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS:
      process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS,
    OPENCODE_KEYS_ACTIVE_KEY_ID: process.env.OPENCODE_KEYS_ACTIVE_KEY_ID,
    OPENCODE_KEYS_PREVIOUS_KEY_ID: process.env.OPENCODE_KEYS_PREVIOUS_KEY_ID,
  };
}
function restoreEnv(saved: SavedEnv): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const codeOfAsync = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (err) {
    const body = (err as { getResponse?: () => { code?: string } }).getResponse?.();
    if (body?.code) return body.code;
    return (err as Error).message;
  }
  assert.fail("expected throw");
};

async function main(): Promise<void> {
  const saved = saveEnv();
  setKeyring(ACTIVE_A);

  const { CryptoService } = await import(
    "../../../../../../../../common/crypto/crypto.service"
  );
  const { BillingService } = await import("../billing.service");

  let passed = 0;
  const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  };

  // --- integrity + mocked billing usage (no PG, no live secret) --------------
  await check("integrity: decrypt == source, keyId in row, mocked usage 200", async () => {
    setKeyring(ACTIVE_A);
    const crypto = new CryptoService();

    type StoredRow = {
      userId: string;
      encryptedKey: string;
      iv: string;
      keyId: string;
      updatedAt: string;
    };
    const table = new Map<string, StoredRow>();
    let saves = 0;
    const fakeKeys = {
      async save(
        userId: string,
        input: { encryptedKey: string; iv: string; keyId: string },
      ): Promise<StoredRow> {
        saves += 1;
        const row: StoredRow = { userId, ...input, updatedAt: new Date().toISOString() };
        table.set(userId, row);
        return row;
      },
      async findByUserId(userId: string): Promise<StoredRow | null> {
        return table.get(userId) ?? null;
      },
    };
    let lastAuth: string | null = null;
    const fakeExternal = {
      async fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
        lastAuth = new Headers(init.headers).get("authorization");
        assert.ok(typeof url === "string" && url.length > 0);
        return new Response(JSON.stringify({ balance: 42.5, usage: 7.25 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };

    const billing = new BillingService(
      fakeKeys as never,
      crypto as never,
      fakeExternal as never,
    );
    const userId = "11111111-1111-4111-8111-111111111111";

    // PUT-like: encrypt first, persist ciphertext only.
    const enc = crypto.encrypt(PLAINTEXT);
    const stored = await fakeKeys.save(userId, {
      encryptedKey: enc.data,
      iv: enc.iv,
      keyId: enc.keyId,
    });
    assert.equal(stored.keyId, crypto.activeKeyId());
    assert.ok(!stored.encryptedKey.includes(PLAINTEXT));
    assert.ok(!stored.iv.includes(PLAINTEXT));
    assert.equal(
      crypto.decrypt({ keyId: stored.keyId, iv: stored.iv, data: stored.encryptedKey }),
      PLAINTEXT,
    );

    // GET-like usage via mock: decrypt integrity + per-user Bearer.
    lastAuth = null;
    const out = await billing.getUsage(userId);
    assert.equal(out.balance, 42.5);
    assert.equal(out.usage, 7.25);
    assert.ok(typeof out.updatedAt === "string" && out.updatedAt.length > 0);
    assert.equal(lastAuth, `Bearer ${PLAINTEXT}`);
    assert.ok(!JSON.stringify(out).includes(PLAINTEXT));
    assert.equal(saves, 1);

    // Missing key → 404 (no secret needed).
    assert.equal(await codeOfAsync(() => billing.getUsage("22222222-2222-4222-8222-222222222222")), "opencode_key_missing");
  });

  await check("billing lazy re-encrypt: stale row serves 200 then converges to active", async () => {
    setKeyring(ACTIVE_A);
    const staleCrypto = new CryptoService();
    const staleEnc = staleCrypto.encrypt(PLAINTEXT);

    type StoredRow = {
      userId: string;
      encryptedKey: string;
      iv: string;
      keyId: string;
      updatedAt: string;
    };
    const table = new Map<string, StoredRow>();
    const userId = "33333333-3333-4333-8333-333333333333";
    table.set(userId, {
      userId,
      encryptedKey: staleEnc.data,
      iv: staleEnc.iv,
      keyId: "v1",
      updatedAt: new Date().toISOString(),
    });
    const fakeKeys = {
      async save(
        uid: string,
        input: { encryptedKey: string; iv: string; keyId: string },
      ): Promise<StoredRow> {
        const row: StoredRow = { userId: uid, ...input, updatedAt: new Date().toISOString() };
        table.set(uid, row);
        return row;
      },
      async findByUserId(uid: string): Promise<StoredRow | null> {
        return table.get(uid) ?? null;
      },
    };
    const fakeExternal = {
      async fetchWithRetry(): Promise<Response> {
        return new Response(JSON.stringify({ balance: 42.5, usage: 7.25 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };

    // Rotate before the read: stale v1 row must still serve via previous.
    setKeyring(ACTIVE_B, { activeId: "v2", previous: ACTIVE_A, previousId: "v1" });
    try {
      const billing = new BillingService(
        fakeKeys as never,
        new CryptoService() as never,
        fakeExternal as never,
      );
      const out = await billing.getUsage(userId);
      assert.equal(out.balance, 42.5);
      const converged = table.get(userId);
      assert.ok(converged);
      assert.equal(converged?.keyId, "v2");
      assert.equal(
        new CryptoService().decrypt({
          keyId: converged?.keyId,
          iv: converged?.iv as string,
          data: converged?.encryptedKey as string,
        }),
        PLAINTEXT,
      );
      // Second read stays on the active KEK (no further rotation needed).
      const again = await billing.getUsage(userId);
      assert.equal(again.usage, 7.25);
      assert.equal(table.get(userId)?.keyId, "v2");
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  restoreEnv(saved);
  console.log(`billing key rotation spec: ${passed} checks run`);
}

void main();
