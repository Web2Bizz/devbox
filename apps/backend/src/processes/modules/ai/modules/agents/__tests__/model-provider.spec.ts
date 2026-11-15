/**
 * Model provider registry checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/agents/__tests__/model-provider.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers card C1: in-code provider registry, flattened tools-only chain,
 * zod boundary validation (fail-fast) and per-user key loading through the
 * shared VaultService + CryptoService (round-robin picks, no fallback to
 * another provider's key).
 */
import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import { ASK_FALLBACK_MODELS } from "../model-fallback";
import {
  MODEL_CHAIN,
  MODEL_PROVIDERS,
  MODEL_TRANSPORTS,
  buildModelChain,
  loadProviderKey,
  validateModelProviders,
} from "../model-provider";

type StoredKey = {
  id: string;
  consumerKind: "user" | "org";
  consumerId: string;
  provider: string;
  label: string;
  encryptedKey: string;
  iv: string;
  keyId: string;
  createdAt: string;
  updatedAt: string;
};

type Consumer = { kind: "user"; userId: string } | { kind: "org"; organizationId: string };

type PickCall = {
  consumer: Consumer;
  provider: string;
  correlationId?: string;
};

type RewrapCall = {
  consumer: Consumer;
  id: string;
  envelope: { encryptedKey: string; iv: string; keyId: string };
  correlationId?: string;
};

type FakeKeys = {
  pickCalls: Array<PickCall>;
  rewrapCalls: Array<RewrapCall>;
  pickNext: (
    consumer: Consumer,
    provider: string,
    correlationId?: string,
  ) => Promise<StoredKey | null>;
  rewrap: (
    consumer: Consumer,
    id: string,
    envelope: { encryptedKey: string; iv: string; keyId: string },
    correlationId?: string,
  ) => Promise<StoredKey | null>;
  list: (consumer: Consumer, provider?: string) => Promise<Array<StoredKey>>;
};

type DecryptCall = { keyId?: string | null; iv: string; data: string };

type FakeCrypto = {
  decryptCalls: Array<DecryptCall>;
  encryptCalls: Array<string>;
  decrypt: (input: DecryptCall) => string;
  isActiveKeyId: (keyId: string | null | undefined) => boolean;
  encrypt: (plain: string) => { keyId: string; iv: string; data: string };
};

const CIPHER_IV = "cipher-iv";
const CIPHER_DATA = "cipher-data";
const PLAINTEXT = "sk-user-plain";

/** Fresh envelope returned by the fake active-KEK encrypt. */
const FRESH_ENVELOPE = {
  keyId: "v2",
  iv: "fresh-iv",
  data: "fresh-data",
};

function storedRow(keyId: string, provider = "opencode"): StoredKey {
  return {
    id: `${provider}-${keyId}`,
    consumerKind: "user",
    consumerId: "u1",
    provider,
    label: "default",
    encryptedKey: CIPHER_DATA,
    iv: CIPHER_IV,
    keyId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeKeys(options: {
  row?: StoredKey | null;
  failPick?: Error;
  failRewrap?: Error;
} = {}): FakeKeys {
  const state: FakeKeys = {
    pickCalls: [],
    rewrapCalls: [],
    pickNext: async (consumer, provider, correlationId) => {
      state.pickCalls.push({ consumer, provider, correlationId });
      if (options.failPick) throw options.failPick;
      return options.row && options.row.provider === provider
        ? options.row
        : null;
    },
    rewrap: async (consumer, id, envelope, correlationId) => {
      state.rewrapCalls.push({ consumer, id, envelope, correlationId });
      if (options.failRewrap) throw options.failRewrap;
      return {
        id,
        consumerKind: consumer.kind,
        consumerId:
          consumer.kind === "user" ? consumer.userId : consumer.organizationId,
        provider: options.row?.provider ?? "opencode",
        label: options.row?.label ?? "default",
        encryptedKey: envelope.encryptedKey,
        iv: envelope.iv,
        keyId: envelope.keyId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    },
    list: async () => (options.row ? [options.row] : []),
  };
  return state;
}

function fakeCrypto(options: {
  active?: boolean;
  failDecrypt?: Error;
  failEncrypt?: Error;
} = {}): FakeCrypto {
  const state: FakeCrypto = {
    decryptCalls: [],
    encryptCalls: [],
    decrypt: (input) => {
      state.decryptCalls.push(input);
      if (options.failDecrypt) throw options.failDecrypt;
      return PLAINTEXT;
    },
    isActiveKeyId: () => options.active ?? true,
    encrypt: (plain) => {
      state.encryptCalls.push(plain);
      if (options.failEncrypt) throw options.failEncrypt;
      return { ...FRESH_ENVELOPE };
    },
  };
  return state;
}

function deps(keys: FakeKeys, crypto: FakeCrypto) {
  return { keys: keys as never, crypto: crypto as never };
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

type Check = { name: string; run: () => Promise<void> | void };

const checks: Array<Check> = [
  {
    name: "transports are pinned to the two supported names",
    run: () => {
      assert.deepEqual([...MODEL_TRANSPORTS], [
        "inprocess-opencode",
        "http-openai",
      ]);
    },
  },
  {
    name: "registry: provider ids are unique",
    run: () => {
      const ids = MODEL_PROVIDERS.map((provider) => provider.id);
      assert.equal(new Set(ids).size, ids.length);
    },
  },
  {
    name: "opencode: in-process transport with the ask fallback order",
    run: () => {
      const opencode = MODEL_PROVIDERS.find(
        (provider) => provider.id === "opencode",
      );
      assert.ok(opencode);
      assert.equal(opencode.transport, "inprocess-opencode");
      assert.equal(opencode.baseURL, undefined);
      assert.deepEqual(
        opencode.models.map((model) => model.id),
        [...ASK_FALLBACK_MODELS],
      );
      assert.deepEqual(
        opencode.models.map((model) => model.priority),
        ASK_FALLBACK_MODELS.map((_, index) => index),
      );
      for (const model of opencode.models) {
        assert.equal(model.tools, true);
      }
    },
  },
  {
    name: "openrouter: http transport, fixed baseURL, empty catalog",
    run: () => {
      const openrouter = MODEL_PROVIDERS.find(
        (provider) => provider.id === "openrouter",
      );
      assert.ok(openrouter);
      assert.equal(openrouter.transport, "http-openai");
      assert.equal(openrouter.baseURL, "https://openrouter.ai/api/v1");
      assert.deepEqual(openrouter.models, []);
    },
  },
  {
    name: "MODEL_CHAIN: tools-only flattening in provider/priority order",
    run: () => {
      assert.deepEqual(
        MODEL_CHAIN.map((entry) => entry.model),
        [...ASK_FALLBACK_MODELS],
      );
      for (const entry of MODEL_CHAIN) {
        assert.equal(entry.provider, "opencode");
        assert.equal(entry.transport, "inprocess-opencode");
        assert.equal(entry.baseURL, undefined);
        assert.equal(entry.jsonSchema, false);
        assert.equal(entry.zdr, undefined);
      }
      assert.deepEqual(MODEL_CHAIN, buildModelChain(MODEL_PROVIDERS));
    },
  },
  {
    name: "validateModelProviders: a valid registry passes as-is",
    run: () => {
      const registry = validateModelProviders([
        { id: "alpha", transport: "inprocess-opencode", models: [] },
        {
          id: "beta",
          transport: "http-openai",
          baseURL: "https://beta.example/v1",
          models: [],
        },
      ]);
      assert.equal(registry.length, 2);
      assert.equal(registry[0]?.id, "alpha");
      assert.equal(registry[1]?.baseURL, "https://beta.example/v1");
    },
  },
  {
    name: "validateModelProviders: duplicate provider id throws",
    run: () => {
      const error = captureThrow(() =>
        validateModelProviders([
          { id: "dup", transport: "inprocess-opencode", models: [] },
          { id: "dup", transport: "inprocess-opencode", models: [] },
        ]),
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid model provider registry/);
      assert.match(error.message, /Duplicate provider id 'dup'/);
    },
  },
  {
    name: "validateModelProviders: duplicate model id throws",
    run: () => {
      const error = captureThrow(() =>
        validateModelProviders([
          {
            id: "dup-model",
            transport: "inprocess-opencode",
            models: [
              { id: "same", tools: true, jsonSchema: false, priority: 0 },
              { id: "same", tools: true, jsonSchema: false, priority: 1 },
            ],
          },
        ]),
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /Duplicate model id 'same'/);
    },
  },
  {
    name: "validateModelProviders: http-openai without baseURL throws",
    run: () => {
      const error = captureThrow(() =>
        validateModelProviders([
          { id: "no-url", transport: "http-openai", models: [] },
        ]),
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /baseURL is required/);
    },
  },
  {
    name: "validateModelProviders: empty provider id throws",
    run: () => {
      const error = captureThrow(() =>
        validateModelProviders([
          { id: "", transport: "inprocess-opencode", models: [] },
        ]),
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid model provider registry/);
    },
  },
  {
    name: "chain builder: tools:false dropped, priority and provider order kept",
    run: () => {
      const registry = validateModelProviders([
        {
          id: "alpha",
          transport: "inprocess-opencode",
          models: [
            { id: "alpha-second", tools: true, jsonSchema: false, priority: 5 },
            { id: "alpha-skip", tools: false, jsonSchema: true, priority: 1 },
            { id: "alpha-first", tools: true, jsonSchema: true, priority: 2 },
          ],
        },
        {
          id: "beta",
          transport: "http-openai",
          baseURL: "https://beta.example/v1",
          models: [
            {
              id: "beta-first",
              tools: true,
              jsonSchema: true,
              zdr: true,
              priority: 0,
            },
          ],
        },
      ]);
      const chain = buildModelChain(registry);
      assert.deepEqual(
        chain.map((entry) => `${entry.provider}/${entry.model}`),
        ["alpha/alpha-first", "alpha/alpha-second", "beta/beta-first"],
      );
      assert.equal(chain[0]?.zdr, undefined);
      assert.equal(chain[1]?.baseURL, undefined);
      assert.equal(chain[2]?.baseURL, "https://beta.example/v1");
      assert.equal(chain[2]?.zdr, true);
    },
  },
  {
    name: "loadProviderKey: opencode without a row → 404 opencode_key_missing",
    run: async () => {
      const keys = fakeKeys({ row: null });
      const crypto = fakeCrypto();
      const error = await captureError(() =>
        loadProviderKey(deps(keys, crypto), "u1", "opencode", "cid-missing"),
      );
      assert.ok(error instanceof NotFoundException);
      assert.equal(error.getStatus(), 404);
      assert.deepEqual(error.getResponse(), {
        code: "opencode_key_missing",
        message: "No OpenCode API key configured for this user",
      });
      assert.equal(keys.pickCalls.length, 1);
      assert.equal(keys.pickCalls[0]?.provider, "opencode");
      assert.deepEqual(keys.pickCalls[0]?.consumer, { kind: "user", userId: "u1" });
      assert.equal(keys.pickCalls[0]?.correlationId, "cid-missing");
      assert.equal(crypto.decryptCalls.length, 0);
      assert.equal(keys.rewrapCalls.length, 0);
    },
  },
  {
    name: "loadProviderKey: opencode valid row → decrypted plaintext",
    run: async () => {
      const keys = fakeKeys({ row: storedRow("v1") });
      const crypto = fakeCrypto({ active: true });
      const key = await loadProviderKey(
        deps(keys, crypto),
        "u1",
        "opencode",
        "cid-valid",
      );
      assert.equal(key, PLAINTEXT);
      assert.deepEqual(crypto.decryptCalls, [
        { keyId: "v1", iv: CIPHER_IV, data: CIPHER_DATA },
      ]);
      assert.equal(crypto.encryptCalls.length, 0);
      assert.equal(keys.rewrapCalls.length, 0);
      assert.equal(keys.pickCalls[0]?.provider, "opencode");
      assert.equal(keys.pickCalls[0]?.correlationId, "cid-valid");
    },
  },
  {
    name: "loadProviderKey: stale keyId → lazy re-encrypt under the active KEK",
    run: async () => {
      const keys = fakeKeys({ row: storedRow("v1") });
      const crypto = fakeCrypto({ active: false });
      const key = await loadProviderKey(
        deps(keys, crypto),
        "u1",
        "opencode",
        "cid-stale",
      );
      assert.equal(key, PLAINTEXT);
      assert.deepEqual(crypto.encryptCalls, [PLAINTEXT]);
      assert.equal(keys.rewrapCalls.length, 1);
      assert.deepEqual(keys.rewrapCalls[0], {
        consumer: { kind: "user", userId: "u1" },
        id: "opencode-v1",
        envelope: {
          encryptedKey: FRESH_ENVELOPE.data,
          iv: FRESH_ENVELOPE.iv,
          keyId: FRESH_ENVELOPE.keyId,
        },
        correlationId: "cid-stale",
      });
    },
  },
  {
    name: "loadProviderKey: only opencode row → openrouter 404 provider_key_missing",
    run: async () => {
      const keys = fakeKeys({ row: storedRow("v1") });
      const crypto = fakeCrypto({ active: true });
      const error = await captureError(() =>
        loadProviderKey(deps(keys, crypto), "u1", "openrouter", "cid-or"),
      );
      assert.ok(error instanceof NotFoundException);
      assert.equal(error.getStatus(), 404);
      assert.deepEqual(error.getResponse(), {
        code: "provider_key_missing",
        message: "No openrouter API key configured for this user",
      });
      // The (consumer, provider) lookup happens for openrouter itself; decrypt
      // never runs and the opencode row is never used as a fallback.
      assert.equal(keys.pickCalls.length, 1);
      assert.equal(keys.pickCalls[0]?.provider, "openrouter");
      assert.equal(keys.rewrapCalls.length, 0);
      assert.equal(crypto.decryptCalls.length, 0);
      assert.equal(crypto.encryptCalls.length, 0);
    },
  },
  {
    name: "loadProviderKey: openrouter row → its own plaintext",
    run: async () => {
      const keys = fakeKeys({ row: storedRow("v1", "openrouter") });
      const crypto = fakeCrypto({ active: true });
      const key = await loadProviderKey(
        deps(keys, crypto),
        "u1",
        "openrouter",
        "cid-or-row",
      );
      assert.equal(key, PLAINTEXT);
      assert.equal(keys.pickCalls[0]?.provider, "openrouter");
      assert.deepEqual(crypto.decryptCalls, [
        { keyId: "v1", iv: CIPHER_IV, data: CIPHER_DATA },
      ]);
      assert.equal(keys.rewrapCalls.length, 0);
    },
  },
  {
    name: "loadProviderKey: stale openrouter → lazy re-encrypt keeps provider",
    run: async () => {
      const keys = fakeKeys({ row: storedRow("v1", "openrouter") });
      const crypto = fakeCrypto({ active: false });
      const key = await loadProviderKey(
        deps(keys, crypto),
        "u1",
        "openrouter",
        "cid-or-stale",
      );
      assert.equal(key, PLAINTEXT);
      assert.deepEqual(crypto.encryptCalls, [PLAINTEXT]);
      assert.deepEqual(keys.rewrapCalls[0], {
        consumer: { kind: "user", userId: "u1" },
        id: "openrouter-v1",
        envelope: {
          encryptedKey: FRESH_ENVELOPE.data,
          iv: FRESH_ENVELOPE.iv,
          keyId: FRESH_ENVELOPE.keyId,
        },
        correlationId: "cid-or-stale",
      });
    },
  },
  {
    name: "loadProviderKey: unknown provider → programmer error",
    run: async () => {
      const keys = fakeKeys();
      const crypto = fakeCrypto();
      const error = await captureError(() =>
        loadProviderKey(deps(keys, crypto), "u1", "unknown", "cid-unknown"),
      );
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof NotFoundException));
      assert.match(error.message, /Unknown model provider 'unknown'/);
      assert.equal(keys.pickCalls.length, 0);
      assert.equal(crypto.decryptCalls.length, 0);
    },
  },
  {
    name: "loadProviderKey: dbUnavailable from keys propagates as-is",
    run: async () => {
      const dbError = new Error("EXTERNAL_UNAVAILABLE db down");
      const keys = fakeKeys({ failPick: dbError });
      const crypto = fakeCrypto();
      const error = await captureError(() =>
        loadProviderKey(deps(keys, crypto), "u1", "opencode", "cid-db"),
      );
      assert.equal(error, dbError);
      assert.equal(crypto.decryptCalls.length, 0);
    },
  },
  {
    name: "loadProviderKey: decrypt failure propagates as-is",
    run: async () => {
      const decryptError = new Error("opencode_key_unreadable");
      const keys = fakeKeys({ row: storedRow("v1") });
      const crypto = fakeCrypto({ failDecrypt: decryptError });
      const error = await captureError(() =>
        loadProviderKey(deps(keys, crypto), "u1", "opencode", "cid-decrypt"),
      );
      assert.equal(error, decryptError);
      assert.equal(keys.rewrapCalls.length, 0);
    },
  },
  {
    name: "loadProviderKey: failed re-encrypt only warns, plaintext still returns",
    run: async () => {
      const keys = fakeKeys({
        row: storedRow("v1"),
        failRewrap: new Error("rewrap failed"),
      });
      const crypto = fakeCrypto({ active: false });
      const key = await loadProviderKey(
        deps(keys, crypto),
        "u1",
        "opencode",
        "cid-save-fail",
      );
      assert.equal(key, PLAINTEXT);
      assert.equal(keys.rewrapCalls.length, 1);
      assert.deepEqual(crypto.encryptCalls, [PLAINTEXT]);
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
    console.error(`${failed}/${checks.length} model provider checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} model provider checks failed`);
  }
  console.log(`${checks.length}/${checks.length} model provider checks passed`);
}

void main().catch((error: unknown) => {
  console.error(
    `model provider checks failed to run: ${(error as Error).message}`,
  );
  process.exit(1);
});
