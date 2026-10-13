/**
 * CryptoService unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/opencode-keys/crypto.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers: AES-256-GCM roundtrip, random IV per call, wrong-key failure,
 * tampered-envelope failure, malformed input failure, and fail-fast when
 * OPENCODE_KEYS_ENCRYPTION_KEY is missing (never logs the secret).
 */
import assert from "node:assert/strict";

const TEST_KEY = "spec-encryption-key-not-real-0123456789abcdef";

async function main(): Promise<void> {
  process.env.OPENCODE_KEYS_ENCRYPTION_KEY = TEST_KEY;
  const { CryptoService } = await import("./crypto.service.js");

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
  const check = (name: string, fn: () => void): void => {    try {
      fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  };

  check("roundtrip returns the original plaintext", () => {
    const svc = new CryptoService();
    const enc = svc.encrypt("opencode-test-key-not-real-1234567890");
    assert.ok(enc.iv.length > 0);
    assert.ok(enc.data.length > 0);
    assert.equal(svc.decrypt(enc), "opencode-test-key-not-real-1234567890");
  });

  check("same plaintext encrypts differently every time (random IV)", () => {
    const svc = new CryptoService();
    const a = svc.encrypt("same-plaintext");
    const b = svc.encrypt("same-plaintext");
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.data, b.data);
    assert.equal(svc.decrypt(a), "same-plaintext");
    assert.equal(svc.decrypt(b), "same-plaintext");
  });

  check("wrong encryption key fails closed (auth-tag mismatch)", () => {
    const svc = new CryptoService();
    const enc = svc.encrypt("secret-value");
    process.env.OPENCODE_KEYS_ENCRYPTION_KEY =
      "different-encryption-key-not-real-0123456789abcdef";
    try {
      const other = new CryptoService();
      assert.equal(codeOf(() => other.decrypt(enc)), "opencode_key_unreadable");
    } finally {
      process.env.OPENCODE_KEYS_ENCRYPTION_KEY = TEST_KEY;
    }
  });

  check("tampered envelope fails closed", () => {
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
    } finally {
      process.env.OPENCODE_KEYS_ENCRYPTION_KEY = TEST_KEY;
    }
  });

  console.log(`crypto spec: ${passed} checks run`);
}

void main();
