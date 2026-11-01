/**
 * CryptoService hardening + rotation-convergence checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/common/crypto/__tests__/crypto.service.hardening.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Complements crypto.service.spec.ts (which owns roundtrip/random-IV/
 * legacy/rotation/wrong-key/tamper/malformed/missing + env.spec.ts KEK
 * validation + keys.e2e.ts PG-backed lifecycle): this file pins
 * boundary values (empty/unicode/huge), hostile envelopes (null/undefined/
 * non-string/short-IV/long-IV/short-data/swapped/tampered-tag/truncated),
 * KEK misconfiguration edges (short active, malformed ids, same-id no-op,
 * whitespace trim, isActiveKeyId falsy/unconfigured), no-caching across env
 * swaps, log hygiene (fixed event only), plus DB-free rotation convergence
 * (old row via previous → re-encrypt under active → key_id updated).
 *
 * Billing usage integrity + lazy re-encrypt convergence live in
 * processes/modules/ai/modules/opencode/modules/billing/__tests__/billing-key-rotation.spec.ts —
 * common must not import processes.
 *
 * Dummy KEKs only (≥32 chars, `...-not-real-...`), via process.env in-test,
 * never logged (roles + keyIds only, never values). .env.example keeps the
 * placeholder + comment (no real secrets there either).
 */
import assert from "node:assert/strict";

// --- Dummy key material (test-only, never a real OpenCode API key) ---------
const ACTIVE_A = "hardening-test-kek-active-not-real-0123456789abcd";
const PREVIOUS_A = "hardening-test-kek-previous-not-real-0123456789ab";
const ACTIVE_B = "hardening-test-kek-rotated-not-real-0123456789abcd";
const THIRD_C = "hardening-test-kek-third-not-real-0123456789abcdef";
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

function clearKeyring(): void {
  delete process.env.OPENCODE_KEYS_ENCRYPTION_KEY;
  delete process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS;
  delete process.env.OPENCODE_KEYS_ACTIVE_KEY_ID;
  delete process.env.OPENCODE_KEYS_PREVIOUS_KEY_ID;
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

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
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

  const { CryptoService } = await import("../crypto.service");
  const { AppLogger } = await import("../../logger");

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

  // --- normal: envelope + integrity ---------------------------------------
  await check("round-trip decrypt matches source, keyId envelope persists", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    assert.equal(svc.activeKeyId(), "v1");
    const enc = svc.encrypt(PLAINTEXT);
    assert.equal(enc.keyId, "v1");
    assert.equal(enc.keyId, svc.activeKeyId());
    assert.equal(svc.decrypt(enc), PLAINTEXT);
    assert.equal(svc.decrypt({ keyId: enc.keyId, iv: enc.iv, data: enc.data }), PLAINTEXT);
  });

  await check("base64 shape: 12-byte IV, ciphertext+16-byte tag", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const enc = svc.encrypt(PLAINTEXT);
    assert.equal(Buffer.from(enc.iv, "base64").length, 12);
    assert.ok(Buffer.from(enc.data, "base64").length > 16);
  });

  // --- boundary: empty / unicode / huge -----------------------------------
  await check("boundary: empty string round-trips", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const enc = svc.encrypt("");
    assert.equal(svc.decrypt(enc), "");
  });

  await check("boundary: unicode/emoji/multiline/whitespace round-trips", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const tricky = "ключ-🔑-test-日本語\nline2\t tab  padded  ";
    const enc = svc.encrypt(tricky);
    assert.equal(svc.decrypt(enc), tricky);
  });

  await check("boundary: huge (32KB) plaintext round-trips", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const huge = "x".repeat(32768);
    const enc = svc.encrypt(huge);
    assert.equal(svc.decrypt(enc), huge);
  });

  await check("boundary: 1024-char apiKey-like value round-trips", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const long = `sk-${"a".repeat(1021)}`;
    assert.equal(long.length, 1024);
    assert.equal(svc.decrypt(svc.encrypt(long)), long);
  });

  await check("boundary: many encrypts keep distinct IVs, all decrypt", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const enc = svc.encrypt(PLAINTEXT);
      assert.ok(!seen.has(enc.iv), "IV reuse");
      seen.add(enc.iv);
      assert.equal(svc.decrypt(enc), PLAINTEXT);
    }
    assert.equal(seen.size, 20);
  });

  // --- hostile: encrypt invalid types --------------------------------------
  await check("hostile: encrypt null/undefined/non-string throws (no envelope)", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    for (const bad of [null, undefined, 123, true, {}, []] as unknown as string[]) {
      assert.throws(() => svc.encrypt(bad));
    }
  });

  // --- hostile: decrypt null/undefined/missing/non-string -----------------
  await check("hostile: decrypt null/undefined/empty-object fails closed", async () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    for (const bad of [null, undefined, {}, { iv: "", data: "" }] as unknown as Array<{
      keyId?: string;
      iv: string;
      data: string;
    }>) {
      assert.equal(codeOf(() => svc.decrypt(bad as never)), "opencode_key_unreadable");
    }
  });

  await check("hostile: decrypt missing/non-string iv/data fails closed", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const good = svc.encrypt(PLAINTEXT);
    const cases = [
      { keyId: "v1", data: good.data },
      { keyId: "v1", iv: good.iv },
      { keyId: "v1", iv: 123, data: good.data },
      { keyId: "v1", iv: good.iv, data: 456 },
      { keyId: "v1", iv: null, data: good.data },
      { keyId: "v1", iv: good.iv, data: null },
      { keyId: "v1", iv: "", data: "" },
      { keyId: "v1", iv: "   ", data: "   " },
    ] as unknown as Array<{ keyId: string; iv: string; data: string }>;
    for (const c of cases) {
      assert.equal(codeOf(() => svc.decrypt(c)), "opencode_key_unreadable");
    }
  });

  await check("hostile: decrypt invalid-base64 / short-IV / long-IV fails closed", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const good = svc.encrypt(PLAINTEXT);
    assert.equal(codeOf(() => svc.decrypt({ iv: "!!!", data: "!!! " })), "opencode_key_unreadable");
    const shortIv = Buffer.alloc(11).toString("base64");
    const longIv = Buffer.alloc(13).toString("base64");
    assert.equal(codeOf(() => svc.decrypt({ iv: shortIv, data: good.data })), "opencode_key_unreadable");
    assert.equal(codeOf(() => svc.decrypt({ iv: longIv, data: good.data })), "opencode_key_unreadable");
  });

  await check("hostile: decrypt tag-only / tiny / swapped / truncated fails closed", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const good = svc.encrypt(PLAINTEXT);
    const tagOnly = Buffer.alloc(16).toString("base64");
    const oneByte = Buffer.alloc(1).toString("base64");
    assert.equal(codeOf(() => svc.decrypt({ iv: good.iv, data: tagOnly })), "opencode_key_unreadable");
    assert.equal(codeOf(() => svc.decrypt({ iv: good.iv, data: oneByte })), "opencode_key_unreadable");
    assert.equal(
      codeOf(() => svc.decrypt({ keyId: good.keyId, iv: good.data, data: good.iv })),
      "opencode_key_unreadable",
    );
    const raw = Buffer.from(good.data, "base64");
    const truncated = raw.subarray(0, Math.floor(raw.length / 2)).toString("base64");
    assert.equal(codeOf(() => svc.decrypt({ iv: good.iv, data: truncated })), "opencode_key_unreadable");
  });

  await check("hostile: tampered IV / tampered tag fails closed", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const enc = svc.encrypt(PLAINTEXT);
    const iv = Buffer.from(enc.iv, "base64");
    iv[0] ^= 0xff;
    assert.equal(
      codeOf(() => svc.decrypt({ iv: iv.toString("base64"), data: enc.data })),
      "opencode_key_unreadable",
    );
    const data = Buffer.from(enc.data, "base64");
    data[data.length - 1] ^= 0xff;
    assert.equal(
      codeOf(() => svc.decrypt({ iv: enc.iv, data: data.toString("base64") })),
      "opencode_key_unreadable",
    );
  });

  await check("hostile: wrong KEK rejected (explicit keyId + legacy shape)", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const enc = svc.encrypt(PLAINTEXT);
    process.env.OPENCODE_KEYS_ENCRYPTION_KEY = ACTIVE_B;
    try {
      const other = new CryptoService();
      assert.equal(codeOf(() => other.decrypt(enc)), "opencode_key_unreadable");
      assert.equal(
        codeOf(() => other.decrypt({ iv: enc.iv, data: enc.data })),
        "opencode_key_unreadable",
      );
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  await check("hostile: third (unknown) KEK fails even with dual-read ring", () => {
    setKeyring(THIRD_C);
    const third = new CryptoService();
    const foreign = third.encrypt(PLAINTEXT);
    setKeyring(ACTIVE_A, { previous: PREVIOUS_A });
    try {
      const svc = new CryptoService();
      assert.equal(
        codeOf(() => svc.decrypt({ keyId: "v9", iv: foreign.iv, data: foreign.data })),
        "opencode_key_unreadable",
      );
      assert.equal(
        codeOf(() => svc.decrypt({ keyId: foreign.keyId, iv: foreign.iv, data: foreign.data })),
        "opencode_key_unreadable",
      );
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  // --- KEK misconfiguration edges ------------------------------------------
  await check("short active KEK fails closed without echoing the value", () => {
    setKeyring("too-short-active-not-a-secret");
    try {
      const svc = new CryptoService();
      const msg = codeOf(() => svc.encrypt(PLAINTEXT));
      assert.equal(msg, "opencode_keys_unconfigured");
      assert.equal(codeOf(() => svc.activeKeyId()), "opencode_keys_unconfigured");
      assert.equal(svc.isActiveKeyId("v1"), false);
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  await check("malformed active/previous keyIds fail closed; empty falls back to default", () => {
    setKeyring(ACTIVE_A, { activeId: "bad id!" });
    try {
      assert.equal(codeOf(() => new CryptoService().encrypt(PLAINTEXT)), "opencode_keys_unconfigured");
    } finally {
      setKeyring(ACTIVE_A);
    }
    setKeyring(ACTIVE_A, { previous: PREVIOUS_A, previousId: "bad id!" });
    try {
      assert.equal(codeOf(() => new CryptoService().encrypt(PLAINTEXT)), "opencode_keys_unconfigured");
    } finally {
      setKeyring(ACTIVE_A);
    }
    setKeyring(ACTIVE_A, { activeId: "" });
    try {
      const svc = new CryptoService();
      assert.equal(svc.activeKeyId(), "v1");
      assert.equal(svc.encrypt(PLAINTEXT).keyId, "v1");
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  await check("same id on both sides is a single effective key (no dual-read)", () => {
    setKeyring(ACTIVE_B);
    const before = new CryptoService().encrypt(PLAINTEXT);
    assert.equal(before.keyId, "v1");
    // Same id "v1" on both sides with different secrets → previous is dropped.
    setKeyring(ACTIVE_A, { activeId: "v1", previous: ACTIVE_B, previousId: "v1" });
    try {
      const svc = new CryptoService();
      assert.equal(svc.decrypt(svc.encrypt(PLAINTEXT)), PLAINTEXT);
      assert.equal(codeOf(() => svc.decrypt(before)), "opencode_key_unreadable");
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  await check("whitespace-padded secrets trim to the same key material", () => {
    setKeyring(`  ${ACTIVE_A}  `);
    const svc = new CryptoService();
    const enc = svc.encrypt(PLAINTEXT);
    setKeyring(ACTIVE_A);
    assert.equal(new CryptoService().decrypt(enc), PLAINTEXT);
  });

  await check("isActiveKeyId falsy/unknown/unconfigured edges", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    assert.equal(svc.isActiveKeyId(null), false);
    assert.equal(svc.isActiveKeyId(undefined), false);
    assert.equal(svc.isActiveKeyId(""), false);
    assert.equal(svc.isActiveKeyId("v9"), false);
    assert.equal(svc.isActiveKeyId(" v1 "), false);
    assert.equal(svc.isActiveKeyId("v1"), true);
    clearKeyring();
    try {
      assert.equal(new CryptoService().isActiveKeyId("v1"), false);
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  await check("activeKeyId fail-closed when unconfigured", () => {
    clearKeyring();
    try {
      assert.equal(codeOf(() => new CryptoService().activeKeyId()), "opencode_keys_unconfigured");
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  await check("keyring resolves at USE time (no caching across env swaps)", () => {
    setKeyring(ACTIVE_A);
    const enc = new CryptoService().encrypt(PLAINTEXT);
    setKeyring(ACTIVE_B, { activeId: "v2", previous: ACTIVE_A, previousId: "v1" });
    assert.equal(new CryptoService().decrypt(enc), PLAINTEXT);
    // Drop the previous KEK: the stale row must now fail, fresh rows work.
    setKeyring(ACTIVE_B, { activeId: "v2" });
    const fresh = new CryptoService();
    assert.equal(codeOf(() => fresh.decrypt(enc)), "opencode_key_unreadable");
    assert.equal(fresh.decrypt(fresh.encrypt(PLAINTEXT)), PLAINTEXT);
    setKeyring(ACTIVE_A);
  });

  await check("decrypt failure logs fixed event only (never envelope/secret/plaintext)", () => {
    setKeyring(ACTIVE_A);
    const svc = new CryptoService();
    const enc = svc.encrypt(PLAINTEXT);
    const captured: unknown[] = [];
    const methods = ["debug", "info", "warn", "error"] as const;
    const originals = methods.map((m) => AppLogger.prototype[m]);
    methods.forEach((m, i) => {
      (AppLogger.prototype as unknown as Record<string, (...a: unknown[]) => void>)[m] =
        function (...args: unknown[]) {
          captured.push(args);
          return (originals[i] as (...a: unknown[]) => unknown).apply(this, args);
        };
    });
    try {
      process.env.OPENCODE_KEYS_ENCRYPTION_KEY = ACTIVE_B;
      assert.equal(codeOf(() => new CryptoService().decrypt(enc)), "opencode_key_unreadable");
    } finally {
      methods.forEach((m, i) => {
        (AppLogger.prototype as unknown as Record<string, (...a: unknown[]) => void>)[m] =
          originals[i] as (...a: unknown[]) => void;
      });
      setKeyring(ACTIVE_A);
    }
    const dump = JSON.stringify(captured);
    assert.ok(dump.includes("opencode_key_unreadable"), "fixed event must be logged");
    assert.ok(!dump.includes(PLAINTEXT), "plaintext reached the logs");
    assert.ok(!dump.includes(ACTIVE_A), "active KEK value reached the logs");
    assert.ok(!dump.includes(ACTIVE_B), "wrong KEK value reached the logs");
    assert.ok(!dump.includes(enc.data), "ciphertext reached the logs");
  });

  // --- rotation convergence (DB-free, in-memory row) -------------------------
  await check("rotation: old row reads via previous, re-encrypt converges to active", () => {
    setKeyring(ACTIVE_A);
    const oldSvc = new CryptoService();
    const oldEnc = oldSvc.encrypt(PLAINTEXT);
    assert.equal(oldEnc.keyId, "v1");
    type Row = { userId: string; encryptedKey: string; iv: string; keyId: string };
    const row: Row = {
      userId: "user-rotation",
      encryptedKey: oldEnc.data,
      iv: oldEnc.iv,
      keyId: oldEnc.keyId,
    };
    // Rotate: B active (v2), A previous (v1).
    setKeyring(ACTIVE_B, { activeId: "v2", previous: ACTIVE_A, previousId: "v1" });
    try {
      const rotated = new CryptoService();
      assert.equal(rotated.isActiveKeyId(row.keyId), false);
      const plain = rotated.decrypt({ keyId: row.keyId, iv: row.iv, data: row.encryptedKey });
      assert.equal(plain, PLAINTEXT);
      // Lazy/background re-wrap under the active KEK (new randomness, new id).
      const fresh = rotated.encrypt(plain);
      assert.equal(fresh.keyId, "v2");
      assert.ok(fresh.iv !== row.iv || fresh.data !== row.encryptedKey);
      row.encryptedKey = fresh.data;
      row.iv = fresh.iv;
      row.keyId = fresh.keyId;
      assert.equal(rotated.isActiveKeyId(row.keyId), true);
      assert.equal(
        rotated.decrypt({ keyId: row.keyId, iv: row.iv, data: row.encryptedKey }),
        PLAINTEXT,
      );
      // Drop previous: converged row still opens via active alone.
      setKeyring(ACTIVE_B, { activeId: "v2" });
      assert.equal(
        new CryptoService().decrypt({ keyId: row.keyId, iv: row.iv, data: row.encryptedKey }),
        PLAINTEXT,
      );
      // The pre-rotation envelope no longer opens once previous is dropped.
      assert.equal(codeOf(() => new CryptoService().decrypt(oldEnc)), "opencode_key_unreadable");
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  await check("rotation: legacy row without keyId converges the same way", () => {
    setKeyring(ACTIVE_A);
    const enc = new CryptoService().encrypt(PLAINTEXT);
    const legacy = { iv: enc.iv, data: enc.data };
    setKeyring(ACTIVE_B, { activeId: "v2", previous: ACTIVE_A, previousId: "v1" });
    try {
      const rotated = new CryptoService();
      assert.equal(rotated.decrypt(legacy), PLAINTEXT);
      const fresh = rotated.encrypt(rotated.decrypt(legacy));
      assert.equal(fresh.keyId, "v2");
      assert.equal(rotated.decrypt(fresh), PLAINTEXT);
    } finally {
      setKeyring(ACTIVE_A);
    }
  });

  restoreEnv(saved);
  console.log(`crypto hardening spec: ${passed} checks run`);
}

void main();
