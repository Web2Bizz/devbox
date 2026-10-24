/**
 * CryptoService unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/opencode-keys/crypto.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers: AES-256-GCM roundtrip (keyId envelope), random IV per call,
 * legacy envelopes without keyId (dual-read), KEK rotation (previous KEK
 * decrypts, new encrypts), unknown-keyId/wrong-key failure, tampered and
 * malformed envelopes, fail-fast when OPENCODE_KEYS_ENCRYPTION_KEY is
 * missing (never logs the secret).
 */
import assert from "node:assert/strict";

const KEY_A = "spec-encryption-key-A-not-real-0123456789abcdef";
const KEY_B = "spec-encryption-key-B-not-real-0123456789abcdef";

function setKeyring(active: string, previous?: string): void {
  process.env.OPENCODE_KEYS_ENCRYPTION_KEY = active;
  process.env.OPENCODE_KEYS_ACTIVE_KEY_ID = "v1";
  if (previous === undefined) {
    delete process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS;
  } else {
    process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS = previous;
  }
  process.env.OPENCODE_KEYS_PREVIOUS_KEY_ID = "v0";
}

async function main(): Promise<void> {
  setKeyring(KEY_A);
  const { CryptoService } = await import("./crypto.service");

  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      const body = (
        err as { getResponse?: () => { code?: string } }
      ).getResponse?.();
      if (body?.code) return body.code;
      return (err as Error).message;
    }
    assert.fail("expected throw");
  };
  let passed = 0;
  const check = (name: string, fn: () => void): void => {
    try {
      fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  };

  check("roundtrip returns the original plaintext (keyId envelope)", () => {
    setKeyring(KEY_A);
    const svc = new CryptoService();
    const enc = svc.encrypt("opencode-test-key-not-real-1234567890");
    assert.equal(enc.keyId, "v1");
    assert.ok(enc.iv.length > 0);
    assert.ok(enc.data.length > 0);
    assert.equal(svc.decrypt(enc), "opencode-test-key-not-real-1234567890");
  });

  check("active key id comes from env", () => {
    setKeyring(KEY_A);
    process.env.OPENCODE_KEYS_ACTIVE_KEY_ID = "2026-10";
    try {
      const svc = new CryptoService();
      assert.equal(svc.activeKeyId(), "2026-10");
      assert.equal(svc.encrypt("x").keyId, "2026-10");
      assert.ok(svc.isActiveKeyId("2026-10"));
      assert.ok(!svc.isActiveKeyId("v1"));
    } finally {
      process.env.OPENCODE_KEYS_ACTIVE_KEY_ID = "v1";
    }
  });

  check("same plaintext encrypts differently every time (random IV)", () => {
    setKeyring(KEY_A);
    const svc = new CryptoService();
    const a = svc.encrypt("same-plaintext");
    const b = svc.encrypt("same-plaintext");
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.data, b.data);
    assert.equal(svc.decrypt(a), "same-plaintext");
    assert.equal(svc.decrypt(b), "same-plaintext");
  });

  check("legacy envelope without keyId decrypts (dual-read fallback)", () => {
    setKeyring(KEY_A);
    const svc = new CryptoService();
    const enc = svc.encrypt("secret-value");
    const legacy = { iv: enc.iv, data: enc.data };
    assert.equal(svc.decrypt(legacy), "secret-value");
    assert.equal(
      svc.decrypt({ keyId: "", iv: enc.iv, data: enc.data }),
      "secret-value",
    );
    assert.equal(
      svc.decrypt({ keyId: null, iv: enc.iv, data: enc.data }),
      "secret-value",
    );
  });

  check("rotation: previous KEK decrypts, active KEK encrypts", () => {
    setKeyring(KEY_A);
    const svc = new CryptoService();
    const oldEnc = svc.encrypt("secret-value");
    assert.equal(oldEnc.keyId, "v1");
    // Rotate: B becomes active, A stays as previous.
    process.env.OPENCODE_KEYS_ENCRYPTION_KEY = KEY_B;
    process.env.OPENCODE_KEYS_ACTIVE_KEY_ID = "v2";
    process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
    process.env.OPENCODE_KEYS_PREVIOUS_KEY_ID = "v1";
    try {
      const rotated = new CryptoService();
      // Old row (keyId v1) still opens via the previous KEK (dual-read).
      assert.equal(rotated.decrypt(oldEnc), "secret-value");
      // Legacy-shaped old row (no keyId) also still opens.
      assert.equal(
        rotated.decrypt({ iv: oldEnc.iv, data: oldEnc.data }),
        "secret-value",
      );
      // New writes use the active KEK id.
      const fresh = rotated.encrypt("secret-value");
      assert.equal(fresh.keyId, "v2");
      assert.equal(rotated.decrypt(fresh), "secret-value");
      assert.ok(rotated.isActiveKeyId("v2"));
      assert.ok(!rotated.isActiveKeyId("v1"));
    } finally {
      setKeyring(KEY_A);
    }
  });

  check("wrong encryption key fails closed (auth-tag mismatch)", () => {
    setKeyring(KEY_A);
    const svc = new CryptoService();
    const enc = svc.encrypt("secret-value");
    process.env.OPENCODE_KEYS_ENCRYPTION_KEY =
      "different-encryption-key-not-real-0123456789abcdef";
    try {
      const other = new CryptoService();
      assert.equal(codeOf(() => other.decrypt(enc)), "opencode_key_unreadable");
      // Legacy shape without keyId fails closed too.
      assert.equal(
        codeOf(() => other.decrypt({ iv: enc.iv, data: enc.data })),
        "opencode_key_unreadable",
      );
    } finally {
      setKeyring(KEY_A);
    }
  });

  check("unknown keyId with no previous KEK fails closed", () => {
    setKeyring(KEY_A);
    const svc = new CryptoService();
    assert.equal(
      codeOf(() =>
        svc.decrypt({ keyId: "v9", iv: svc.encrypt("x").iv, data: "eA==" }),
      ),
      "opencode_key_unreadable",
    );
  });

  check("tampered envelope fails closed", () => {
    setKeyring(KEY_A);
    const svc = new CryptoService();
    const enc = svc.encrypt("secret-value");
    const raw = Buffer.from(enc.data, "base64");
    raw[0] ^= 0xff;
    assert.equal(
      codeOf(() => svc.decrypt({ iv: enc.iv, data: raw.toString("base64") })),
      "opencode_key_unreadable",
    );
  });

  check("malformed envelope fails closed", () => {
    setKeyring(KEY_A);
    const svc = new CryptoService();
    assert.equal(codeOf(() => svc.decrypt({ iv: "!!!", data: "!!! " })), "opencode_key_unreadable");
    assert.equal(
      codeOf(() =>
        svc.decrypt({ iv: Buffer.alloc(12).toString("base64"), data: "eA==" }),
      ),
      "opencode_key_unreadable",
    );
  });

  check("missing encryption key fails fast (never echoes the value)", () => {
    delete process.env.OPENCODE_KEYS_ENCRYPTION_KEY;
    try {
      const svc = new CryptoService();
      let code = "";
      try {
        svc.encrypt("x");
      } catch (err) {
        const body = (
          err as { getResponse?: () => { code?: string; message?: string } }
        ).getResponse?.();
        code = body?.code ?? "";
      }
      assert.equal(code, "opencode_keys_unconfigured");
      assert.equal(codeOf(() => svc.activeKeyId()), "opencode_keys_unconfigured");
    } finally {
      setKeyring(KEY_A);
    }
  });

  check("set-but-short previous key fails closed (never echoes the value)", () => {
    setKeyring(KEY_A, "too-short");
    try {
      const svc = new CryptoService();
      assert.equal(codeOf(() => svc.encrypt("x")), "opencode_keys_unconfigured");
    } finally {
      setKeyring(KEY_A);
    }
  });

  console.log(`crypto spec: ${passed} checks run`);
}

void main();
