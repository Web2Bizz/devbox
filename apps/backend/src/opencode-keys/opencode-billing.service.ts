import { HttpException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AppLogger } from "../common/app-logger.service.js";
import { ExternalClient } from "../common/external/external-client.js";
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from "../common/external/external-error.js";
import { DEFAULT_OPENCODE_BILLING_URL, validateEnv } from "../env.js";
import { CryptoService } from "./crypto.service.js";
import { OpencodeKeysService } from "./opencode-keys.service.js";

/** GET /api/v1/opencode/usage response (minimal contract: balance+usage). */
export interface OpencodeUsage {
  balance: number;
  usage: number;
  /** ISO-8601 time of the upstream response (no cache/TTL). */
  updatedAt: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * OpencodeBillingService — live upstream usage for the caller's own key.
 *
 * - Loads the caller's row and decrypts it (missing → 404
 *   `opencode_key_missing` so clients can prompt key setup; undecryptable →
 *   500 from CryptoService).
 * - Raw GET fetch (no SDK — the SDK has no billing surface) to
 *   OPENCODE_BILLING_URL with per-user `Authorization: Bearer`, via
 *   ExternalClient (REQUEST_TIMEOUT_MS budget + EXTERNAL_RETRY_* tuning,
 *   service='opencode-billing'). updatedAt = upstream response time.
 * - Maps the response strictly to { balance, usage } (finite numbers at the
 *   top level; anything else → 503, never a mock).
 * - Errors: upstream 401/403 → 401 `opencode_key_invalid`; 429 → 429
 *   EXTERNAL_RATE_LIMITED; 5xx → EXTERNAL_UPSTREAM_5XX; timeout/network →
 *   ExternalClient's typed error (504/503). Nothing secret-bearing is ever
 *   logged or echoed (fixed messages, headers never logged).
 */
@Injectable()
export class OpencodeBillingService {
  constructor(
    private readonly keys: OpencodeKeysService,
    private readonly crypto: CryptoService,
    private readonly external: ExternalClient,
    private readonly logger: AppLogger = new AppLogger("OpencodeBillingService"),
  ) {}

  private billingUrl(): string {
    try {
      return validateEnv(process.env).opencodeBillingUrl;
    } catch {
      // Read-only fallback for the outbound target (never logged); request
      // validation failures still fail fast at boot via ConfigModule.
      return DEFAULT_OPENCODE_BILLING_URL;
    }
  }

  async getUsage(userId: string, correlationId?: string): Promise<OpencodeUsage> {
    const stored = await this.keys.findByUserId(userId, correlationId);
    if (!stored) {
      throw new NotFoundException({
        code: "opencode_key_missing",
        message: "No OpenCode API key configured for this user",
      });
    }
    const apiKey = this.crypto.decrypt({ iv: stored.iv, data: stored.encryptedKey });

    let res: Response;
    try {
      res = await this.external.fetchWithRetry(
        this.billingUrl(),
        {
          method: "GET",
          headers: { authorization: `Bearer ${apiKey}` },
        },
        { service: "opencode-billing", operation: "getUsage", correlationId },
      );
    } catch (err) {
      if (err instanceof ExternalServiceError || err instanceof HttpException) throw err;
      throw fromUnknown("opencode-billing", "getUsage", err);
    }

    const observedAt = new Date().toISOString();
    if (res.status === 401 || res.status === 403) {
      await res.arrayBuffer().catch(() => null);
      // Fixed event only — never the key, never the upstream body.
      this.logger.warn("[opencode-billing] upstream rejected the key", correlationId);
      throw new UnauthorizedException({
        code: "opencode_key_invalid",
        message: "OpenCode API key was rejected",
      });
    }
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      await res.arrayBuffer().catch(() => null);
      throw fromStatus("opencode-billing", "getUsage", res.status);
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => null);
      throw fromStatus("opencode-billing", "getUsage", res.status);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      await res.arrayBuffer().catch(() => null);
      throw new ExternalServiceError({
        code: "EXTERNAL_UNAVAILABLE",
        service: "opencode-billing",
        operation: "getUsage",
        message: "сервис временно недоступен, повторите позже",
        isRetryable: true,
      });
    }
    const rec = payload as Record<string, unknown> | null;
    const balance = typeof rec === "object" && rec !== null ? rec["balance"] : undefined;
    const usage = typeof rec === "object" && rec !== null ? rec["usage"] : undefined;
    if (!isFiniteNumber(balance) || !isFiniteNumber(usage)) {
      this.logger.warn("[opencode-billing] upstream shape mismatch", correlationId);
      throw new ExternalServiceError({
        code: "EXTERNAL_UNAVAILABLE",
        service: "opencode-billing",
        operation: "getUsage",
        message: "сервис временно недоступен, повторите позже",
        isRetryable: true,
      });
    }
    return { balance, usage, updatedAt: observedAt };
  }
}
