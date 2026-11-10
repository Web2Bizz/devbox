import { NotFoundException } from "@nestjs/common";
import { z } from "zod";
import type { CryptoService, EncryptedOpencodeKey } from "@common/crypto/crypto.service";
import type { VaultService } from "@common/vault/vault.service";
import type { VaultSecret } from "@common/vault/vault.types";
import { AppLogger } from "@common/logger";
import { ASK_FALLBACK_MODELS } from "./model-fallback";

/**
 * SCOPE: Processes → AI → Agents — model provider constants (card C1).
 *
 * Single in-code source of truth for the model layer; no config files:
 * - A provider says HOW the model is reached (`transport`) and WHICH models
 *   exist with the capability flags the chain needs (`tools`, `jsonSchema`,
 *   `zdr`, `priority`). The agent layer never branches on a provider id.
 * - `inprocess-opencode` calls the model through the in-process OpenCode
 *   adapter (per-call user key); `http-openai` is a standard
 *   OpenAI-compatible `baseURL` + key.
 * - The registry and the flattened chain are validated by zod at module load
 *   (fail-fast with a readable error, never a silent default).
 * - Keys stay per-user through the shared VaultService + CryptoService: no new
 *   store, no env/server key, no fallback.
 */

/**
 * How a provider reaches its model.
 * - `inprocess-opencode` — in-process adapter, no HTTP hop, no sidecar.
 * - `http-openai` — OpenAI-compatible endpoint at `baseURL`.
 */
export const MODEL_TRANSPORTS: readonly ["inprocess-opencode", "http-openai"] = [
  "inprocess-opencode",
  "http-openai",
];

/** One of the supported transport names. */
export type ModelTransport = (typeof MODEL_TRANSPORTS)[number];

/** One model of a provider with the capability flags the chain needs. */
export type ProviderModel = {
  /** Upstream model id (must match the provider's own catalog). */
  id: string;
  /** Tool calling is supported by this model. */
  tools: boolean;
  /** Structured output (JSON schema) is supported by this model. */
  jsonSchema: boolean;
  /** Zero data retention is offered for this model (where applicable). */
  zdr?: boolean;
  /** Chain order inside the provider: lower runs first. */
  priority: number;
};

/** One provider registration (transport + model catalog). */
export type ModelProvider = {
  /** Stable provider id, `[a-z0-9-]+` (e.g. `opencode`, `openrouter`). */
  id: string;
  /** How this provider is called. */
  transport: ModelTransport;
  /** Required for `http-openai`, forbidden for `inprocess-opencode`. */
  baseURL?: string;
  /** Model catalog of this provider. */
  models: ReadonlyArray<ProviderModel>;
};

/** One resolved chain candidate (provider + model + flags). */
export type ModelChainEntry = {
  /** Provider id the candidate belongs to. */
  provider: string;
  /** Transport copied from the provider registration. */
  transport: ModelTransport;
  /** Endpoint copied from the provider registration (http-only). */
  baseURL?: string;
  /** Model id inside the provider. */
  model: string;
  /** Structured output support of this model. */
  jsonSchema: boolean;
  /** Zero data retention support (only when the provider declares it). */
  zdr?: boolean;
};

/** Dependencies of `loadProviderKey` (shared per-user vault infrastructure). */
export type ModelProviderKeyDeps = {
  /** Shared vault (per-consumer, per-provider ciphertext store). */
  keys: VaultService;
  /** Existing KEK envelope (decrypt in memory only). */
  crypto: CryptoService;
};

/** Provider ids are lowercase kebab-case constants. */
const PROVIDER_ID_PATTERN: RegExp = /^[a-z0-9-]+$/;

/**
 * Model ids are lowercase; dots are allowed because real upstream ids carry
 * them (e.g. `deepseek-v4.1-flash`), unlike provider ids.
 */
const MODEL_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]*$/;

/** Fixed log scope: event names only, plaintext keys never reach the logs. */
const LOG_SCOPE: string = "model-provider";
const logger: AppLogger = new AppLogger(LOG_SCOPE);

/** One model inside a provider: flags + unique id inside the provider. */
export const providerModelSchema: z.ZodObject<{
  id: z.ZodString;
  tools: z.ZodBoolean;
  jsonSchema: z.ZodBoolean;
  zdr: z.ZodOptional<z.ZodBoolean>;
  priority: z.ZodNumber;
}> = z.object({
  /** Upstream model id. */
  id: z
    .string({ error: "Field id is required" })
    .min(1, { error: "Field id must be non-empty" })
    .regex(MODEL_ID_PATTERN, { error: "Model id has forbidden characters" }),
  /** Tool calling support. */
  tools: z.boolean({ error: "Field tools is required" }),
  /** Structured output support. */
  jsonSchema: z.boolean({ error: "Field jsonSchema is required" }),
  /** Zero data retention support (optional). */
  zdr: z.boolean({ error: "Field zdr must be a boolean" }).optional(),
  /** Chain order inside the provider (lower runs first). */
  priority: z
    .number({ error: "Field priority is required" })
    .int({ error: "Field priority must be an integer" })
    .nonnegative({ error: "Field priority must be non-negative" }),
});

/**
 * Provider boundary: transport/baseURL consistency plus unique model ids
 * inside one provider.
 */
export const modelProviderSchema: z.ZodObject<{
  id: z.ZodString;
  transport: z.ZodEnum<{
    "inprocess-opencode": "inprocess-opencode";
    "http-openai": "http-openai";
  }>;
  baseURL: z.ZodOptional<z.ZodURL>;
  models: z.ZodArray<typeof providerModelSchema>;
}> = z
  .object({
    /** Provider id (`[a-z0-9-]+`). */
    id: z
      .string({ error: "Field id is required" })
      .min(1, { error: "Field id must be non-empty" })
      .regex(PROVIDER_ID_PATTERN, { error: "Provider id has forbidden characters" }),
    /** How the provider is called. */
    transport: z.enum(MODEL_TRANSPORTS, { error: "Unknown model transport" }),
    /** OpenAI-compatible endpoint (http-openai only). */
    baseURL: z.url({ error: "Field baseURL must be a valid URL" }).optional(),
    /** Model catalog. */
    models: z.array(providerModelSchema, {
      error: "Field models must be an array",
    }),
  })
  // type: contextual — zod's own `superRefine` callback types (`output<this>`
  // and `$RefinementCtx<output<this>>`) cannot be restated by an explicit
  // annotation while the schema const itself is still being declared.
  .superRefine((provider, context) => {
    if (provider.transport === "http-openai" && provider.baseURL === undefined) {
      context.addIssue({
        code: "custom",
        message: "Field baseURL is required for transport http-openai",
        path: ["baseURL"],
      });
    }
    if (
      provider.transport === "inprocess-opencode" &&
      provider.baseURL !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Field baseURL is not allowed for transport inprocess-opencode",
        path: ["baseURL"],
      });
    }
    const seen: Set<string> = new Set<string>();
    provider.models.forEach((model, index) => {
      if (seen.has(model.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate model id '${model.id}'`,
          path: ["models", index, "id"],
        });
      }
      seen.add(model.id);
    });
  });

/** Registry boundary: every provider id is unique. */
export const modelRegistrySchema: z.ZodArray<typeof modelProviderSchema> = z
  .array(modelProviderSchema)
  // type: contextual — same zod `superRefine` callback typing as above.
  .superRefine((providers, context) => {
    const seen: Set<string> = new Set<string>();
    providers.forEach((provider, index) => {
      if (seen.has(provider.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate provider id '${provider.id}'`,
          path: [index, "id"],
        });
      }
      seen.add(provider.id);
    });
  });

/**
 * Validates a provider registry (fail-fast, no silent default): a malformed
 * registry is a programmer error and throws a readable `Error`, never
 * degrades to an empty chain.
 */
export function validateModelProviders(
  providers: unknown,
): ReadonlyArray<ModelProvider> {
  const parsed: z.ZodSafeParseResult<Array<ModelProvider>> =
    modelRegistrySchema.safeParse(providers);
  if (!parsed.success) {
    const details: string = parsed.error.issues
      .map((issue) => {
        const path: string = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid model provider registry: ${details}`);
  }
  return parsed.data;
}

/**
 * Flattens a validated registry into chain candidates: providers keep their
 * registry order, models are sorted by `priority`, and `tools: false` models
 * are dropped (the chain only offers tool-capable candidates).
 */
export function buildModelChain(
  providers: ReadonlyArray<ModelProvider>,
): ReadonlyArray<ModelChainEntry> {
  const chain: Array<ModelChainEntry> = [];
  for (const provider of providers) {
    const models: Array<ProviderModel> = provider.models
      .filter((model) => model.tools)
      .slice()
      .sort((left, right) => left.priority - right.priority);
    for (const model of models) {
      chain.push({
        provider: provider.id,
        transport: provider.transport,
        ...(provider.baseURL !== undefined
          ? { baseURL: provider.baseURL }
          : {}),
        model: model.id,
        jsonSchema: model.jsonSchema,
        ...(model.zdr !== undefined ? { zdr: model.zdr } : {}),
      });
    }
  }
  return chain;
}

/**
 * Provider registry — code constants only (no config file, no env).
 *
 * `opencode` reuses the existing ask fallback order as its priority order.
 * `openrouter` is registered with an empty catalog on purpose: model ids are
 * never invented, the catalog is filled in by code when the provider is
 * enabled (card C2b).
 */
export const MODEL_PROVIDERS: ReadonlyArray<ModelProvider> =
  validateModelProviders([
    {
      id: "opencode",
      transport: "inprocess-opencode",
      // `tools: true` is only the chain's claim here: the actual tool
      // capability is confirmed by the in-process catalog on C2 (R6);
      // incompatible models are dropped there.
      models: ASK_FALLBACK_MODELS.map((id, index) => ({
        id,
        tools: true,
        jsonSchema: false,
        priority: index,
      })),
    },
    {
      id: "openrouter",
      transport: "http-openai",
      baseURL: "https://openrouter.ai/api/v1",
      models: [],
    },
  ]);

/**
 * Provider/model chain — built from the validated registry, only models with
 * `tools: true`. Provider order follows the registry; inside a provider the
 * order is ascending `priority`.
 */
export const MODEL_CHAIN: ReadonlyArray<ModelChainEntry> =
  buildModelChain(MODEL_PROVIDERS);

/**
 * Loads the caller's plaintext key for one provider.
 *
 * - Unknown provider id → `Error` (a programmer mistake, not an HTTP error),
 *   thrown before any store access.
 * - Every known provider reads its own (userId, provider) secret from the
 *   shared vault (round-robin when several exist), decrypted in memory via
 *   CryptoService. No row/empty parts → 404: `opencode_key_missing` for
 *   `opencode` (same code as session-runner/billing) and `provider_key_missing`
 *   for every other provider. A stale KEK id is lazily re-encrypted under the
 *   active KEK and saved back for the same provider; a failed re-encrypt only
 *   warns and never fails the call.
 * - No fallback between providers: another provider's row is never read and
 *   the OpenCode key is never used as a key for a different provider.
 * - CryptoService/DbService errors propagate as-is. The plaintext lives only
 *   in the caller's memory and is never logged.
 */
export async function loadProviderKey(
  deps: ModelProviderKeyDeps,
  userId: string,
  providerId: string,
  correlationId?: string,
): Promise<string> {
  const provider: ModelProvider | undefined = MODEL_PROVIDERS.find(
    (entry) => entry.id === providerId,
  );
  if (!provider) {
    throw new Error(`Unknown model provider '${providerId}'`);
  }

  const stored: VaultSecret | null = await deps.keys.pickNext(
    { kind: "user", userId },
    providerId,
    correlationId,
  );
  if (!stored || !stored.encryptedKey || !stored.iv) {
    if (providerId === "opencode") {
      throw new NotFoundException({
        code: "opencode_key_missing",
        message: "No OpenCode API key configured for this user",
      });
    }
    throw new NotFoundException({
      code: "provider_key_missing",
      message: `No ${providerId} API key configured for this user`,
    });
  }
  const apiKey: string = deps.crypto.decrypt({
    keyId: stored.keyId,
    iv: stored.iv,
    data: stored.encryptedKey,
  });
  if (!deps.crypto.isActiveKeyId(stored.keyId)) {
    try {
      const fresh: EncryptedOpencodeKey = deps.crypto.encrypt(apiKey);
      await deps.keys.rewrap(
        { kind: "user", userId },
        stored.id,
        {
          encryptedKey: fresh.data,
          iv: fresh.iv,
          keyId: fresh.keyId,
        },
        correlationId,
      );
      logger.info("[model-provider] key re-encrypted", correlationId);
    } catch {
      logger.warn("[model-provider] lazy re-encrypt skipped", correlationId);
    }
  }
  return apiKey;
}
