import { HttpException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AppLogger } from "@common/logger";
import { ExternalClient } from "@common/external/external-client";
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from "@common/external/external-error";
import { CryptoService, type EncryptedOpencodeKey } from "@common/crypto/crypto.service";
import { OPENCODE_PROVIDER } from "@common/vault/vault.providers";
import { VaultService } from "@common/vault/vault.service";
import type { VaultSecret } from "@common/vault/vault.types";

/** GET /api/v1/usage response (Zen Go contract + legacy backward-compat). */
export type BillingLimitBucket = {
  used: number;
  limit: number;
};

export type BillingUsage = {
  /** Legacy pay-as-you-go fields — present only for legacy upstream payloads. */
  balance?: number;
  /** Legacy pay-as-you-go total — present only for legacy upstream payloads. */
  usage?: number;
  /** ISO-8601 time of the upstream response (no cache/TTL). */
  updatedAt: string;
  /**
   * Zen Go windows mapped to used/limit for backward-compat UI:
   * upstream reports `percent` only, so we expose `{ used: percent, limit: 100 }`.
   * `rolling` is the Zen 5-hour window (20% of the monthly limit);
   * `weekly` is 50%, `monthly` is 100% (see /v2/docs/console/go).
   * Legacy `daily` is kept for old payloads (no Zen daily exists).
   * All buckets pass through ONLY when upstream carries finite numbers —
   * never derived from a total (derivation is forbidden).
   */
  rolling?: BillingLimitBucket;
  daily?: BillingLimitBucket;
  weekly?: BillingLimitBucket;
  monthly?: BillingLimitBucket;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Zen Go usage windows (only the windows upstream actually reported). */
type ZenWindows = {
  rolling?: BillingLimitBucket;
  weekly?: BillingLimitBucket;
  monthly?: BillingLimitBucket;
};

function parseBucket(value: unknown): BillingLimitBucket | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  const used: unknown = record["used"];
  const limit: unknown = record["limit"];
  if (!isFiniteNumber(used) || !isFiniteNumber(limit)) return undefined;
  return { used, limit };
}

/**
 * Zen Go usage window → legacy bucket.
 * Upstream shape (GET /zen/go/v1/usage → /go/v1/usage on inference):
 * `{ status: "ok" | "rate-limited", percent: number, resetsAt: ISO }`.
 * The UI renders used/limit pairs only, so percent is exposed as
 * `{ used: percent, limit: 100 }` (percent is real upstream data, limit 100
 * is the percent scale — not derived from any total). Missing/malformed
 * windows return undefined (omitted, never faked).
 */
function parseZenWindow(value: unknown): BillingLimitBucket | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  const status: unknown = record["status"];
  const percent: unknown = record["percent"];
  const resetsAt: unknown = record["resetsAt"];
  if (status !== "ok" && status !== "rate-limited") return undefined;
  if (!isFiniteNumber(percent)) return undefined;
  if (typeof resetsAt !== "string" || resetsAt.length === 0) return undefined;
  return { used: percent, limit: 100 };
}

/**
 * Extract Zen Go windows from either the documented nested shape
 * `{ usage: { rolling, weekly, monthly } }` or a flat
 * `{ rolling, weekly, monthly }` (defensive — proxy unwraps happen).
 */
function extractZenWindows(record: Record<string, unknown>): ZenWindows | null {
  const nested: Record<string, unknown> | null =
    typeof record["usage"] === "object" && record["usage"] !== null
      ? (record["usage"] as Record<string, unknown>)
      : null;
  const source: Record<string, unknown> = nested ?? record;
  const rolling: BillingLimitBucket | undefined = parseZenWindow(source["rolling"]);
  const weekly: BillingLimitBucket | undefined = parseZenWindow(source["weekly"]);
  const monthly: BillingLimitBucket | undefined = parseZenWindow(source["monthly"]);
  if (!rolling && !weekly && !monthly) return null;
  const output: ZenWindows = {};
  if (rolling) output.rolling = rolling;
  if (weekly) output.weekly = weekly;
  if (monthly) output.monthly = monthly;
  return output;
}

/**
 * Upstream usage endpoint (GET, per-user Bearer) — hard-coded module
 * constant. There is no env override (BILLING_URL was removed from
 * env.ts/.env.example as a breaking change): the endpoint is fixed.
 *
 * Spec (2026-10-19, via context7 + webfetch + live probe):
 * - Official OpenAPI v2 (https://opencode.ai/v2/docs/api,
 *   /v2/openapi.json) describes the LOCAL instance HttpApi only
 *   (server/session/agent/…) — it has NO billing/usage surface.
 * - The real billing/usage surface is Zen Go:
 *   `GET https://opencode.ai/zen/go/v1/usage` (SolidStart file route,
 *   proxies to inference `GET /go/v1/usage`). Live probe: no auth → 401
 *   `{ type: "error", error: { type: "AuthError" } }` (real endpoint);
 *   `https://api.opencode.ai/usage` (old constant) → 200 `Not Found`
 *   catch-all (shape-mismatch → 503). 401 vs catch-all 200 proves the fix.
 * - Success shape is `{ usage: { rolling, weekly, monthly } }`, each window
 *   `{ status: "ok" | "rate-limited", percent: number, resetsAt: ISO }`
 *   (Go limits: 5h = 20% monthly, weekly = 50%, monthly = 100%).
 */
export const BILLING_URL: string = "https://opencode.ai/zen/go/v1/usage";

/**
 * BillingService — live upstream usage for the caller's own key.
 *
 * - Loads the caller's row and decrypts it (missing → 404
 *   `opencode_key_missing` so clients can prompt key setup; undecryptable →
 *   500 from CryptoService). Rows wrapped with a stale KEK are lazily
 *   re-wrapped under the active KEK (best-effort, never fails the request).
 * - Raw GET fetch (no SDK — the SDK has no billing surface) to the
 *   module BILLING_URL constant with per-user `Authorization:
 *   Bearer`, via
 *   ExternalClient (REQUEST_TIMEOUT_MS budget + EXTERNAL_RETRY_* tuning,
 *   service='billing'). updatedAt = upstream response time.
 * - Maps the response strictly (anything else → 503, never a mock):
 *   legacy `{ balance, usage }` finite numbers (backward-compat, kept for
 *   old mocks), or Zen Go `{ usage: { rolling, weekly, monthly } }` each
 *   `{ status, percent, resetsAt }` mapped to `{ used: percent, limit: 100 }`.
 * - Additive breakdown: optional `rolling/daily/weekly/monthly` { used, limit }
 *   pairs pass through ONLY when upstream carries finite numbers for both fields.
 *   Missing/malformed buckets are omitted (undefined) — never derived from
 *   a total (derivation is forbidden: no percentages from totals; limit 100
 *   here is the percent scale for real upstream percent, not a total).
 * - Errors: upstream 401/403 → 401 `opencode_key_invalid`; 429 → 429
 *   EXTERNAL_RATE_LIMITED; 5xx → EXTERNAL_UPSTREAM_5XX; timeout/network →
 *   ExternalClient's typed error (504/503). Nothing secret-bearing is ever
 *   logged or echoed (fixed messages, headers never logged).
 *   Normal-path warns are one-liners with operation/status/code
 *   (`[billing] getUsage … status=… code=…`), without stack and
 *   without URL/body/Bearer; stack/cause (if any) goes to debug only.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly keys: VaultService,
    private readonly crypto: CryptoService,
    private readonly external: ExternalClient,
    private readonly logger: AppLogger = new AppLogger(BillingService.name),
  ) {}

  private billingUrl(): string {
    return BILLING_URL;
  }

  async getUsage(userId: string, correlationId?: string): Promise<BillingUsage> {
    // Missing-key fast path: null/empty row → 404 opencode_key_missing
    // BEFORE any upstream request. Upstream is fetched only when a key
    // exists. 503 comes solely from a real Postgres outage (throw out of
    // db.client() funneled via dbUnavailable in pickNext) — never for
    // "no key stored".
    const stored: VaultSecret | null = await this.keys.pickNext(
      { kind: "user", userId },
      OPENCODE_PROVIDER,
      correlationId,
    );
    if (!stored || !stored.encryptedKey || !stored.iv) {
      throw new NotFoundException({
        code: "opencode_key_missing",
        message: "No OpenCode API key configured for this user",
      });
    }
    // Decrypt in memory only for this request (dual-read across the KEK
    // rotation window via the row's keyId; legacy rows without an id fall
    // back to active → previous). The plaintext never leaves this method
    // except as the upstream Bearer, and is never logged.
    const apiKey: string = this.crypto.decrypt({
      keyId: stored.keyId,
      iv: stored.iv,
      data: stored.encryptedKey,
    });
    // Lazy re-encrypt: rows wrapped with a stale KEK are re-wrapped under
    // the active KEK on read (best-effort — a re-wrap failure only logs and
    // never fails the usage request; the background `keys:reencrypt` pass
    // converges the rest).
    if (!this.crypto.isActiveKeyId(stored.keyId)) {
      try {
        const fresh: EncryptedOpencodeKey = this.crypto.encrypt(apiKey);
        await this.keys.rewrap(
          { kind: "user", userId },
          stored.id,
          {
            encryptedKey: fresh.data,
            iv: fresh.iv,
            keyId: fresh.keyId,
          },
          correlationId,
        );
        this.logger.info("[billing] key re-encrypted", correlationId);
      } catch {
        this.logger.warn("[billing] lazy re-encrypt skipped", correlationId);
      }
    }

    let response: Response;
    try {
      response = await this.external.fetchWithRetry(
        this.billingUrl(),
        {
          method: "GET",
          headers: { authorization: `Bearer ${apiKey}` },
        },
        { service: "billing", operation: "getUsage", correlationId },
      );
    } catch (error) {
      if (error instanceof ExternalServiceError || error instanceof HttpException) throw error;
      throw fromUnknown("billing", "getUsage", error);
    }

    const observedAt: string = new Date().toISOString();
    if (response.status === 401 || response.status === 403) {
      await response.arrayBuffer().catch(() => null);
      // Fixed event only — never the key, never the upstream body.
      // One-liner with operation/status/code, no stack, no secrets.
      this.logger.warn(
        `[billing] getUsage rejected status=${response.status} code=opencode_key_invalid`,
        correlationId,
      );
      throw new UnauthorizedException({
        code: "opencode_key_invalid",
        message: "OpenCode API key was rejected",
      });
    }
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      await response.arrayBuffer().catch(() => null);
      const mapped: ExternalServiceError = fromStatus("billing", "getUsage", response.status);
      this.logger.warn(
        `[billing] getUsage upstream status=${response.status} code=${mapped.code}`,
        correlationId,
      );
      throw mapped;
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => null);
      const mapped: ExternalServiceError = fromStatus("billing", "getUsage", response.status);
      this.logger.warn(
        `[billing] getUsage upstream status=${response.status} code=${mapped.code}`,
        correlationId,
      );
      throw mapped;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      await response.arrayBuffer().catch(() => null);
      this.logger.warn(
        `[billing] getUsage bad json status=${response.status} code=EXTERNAL_UNAVAILABLE`,
        correlationId,
      );
      throw new ExternalServiceError({
        code: "EXTERNAL_UNAVAILABLE",
        service: "billing",
        operation: "getUsage",
        message: "сервис временно недоступен, повторите позже",
        isRetryable: true,
      });
    }
    const record: Record<string, unknown> | null = payload as Record<string, unknown> | null;
    if (typeof record !== "object" || record === null) {
      this.logger.warn(
        `[billing] getUsage shape mismatch status=${response.status} code=EXTERNAL_UNAVAILABLE`,
        correlationId,
      );
      throw new ExternalServiceError({
        code: "EXTERNAL_UNAVAILABLE",
        service: "billing",
        operation: "getUsage",
        message: "сервис временно недоступен, повторите позже",
        isRetryable: true,
      });
    }
    // Legacy pay-as-you-go shape (backward-compat for old mocks): finite
    // top-level { balance, usage } numbers.
    const balance: unknown = record["balance"];
    const usage: unknown = record["usage"];
    if (isFiniteNumber(balance) && isFiniteNumber(usage)) {
      // Additive passthrough: finite { used, limit } pairs only, else omitted.
      const output: BillingUsage = { balance, usage, updatedAt: observedAt };
      const daily: BillingLimitBucket | undefined = parseBucket(record["daily"]);
      const weekly: BillingLimitBucket | undefined = parseBucket(record["weekly"]);
      const monthly: BillingLimitBucket | undefined = parseBucket(record["monthly"]);
      if (daily) output.daily = daily;
      if (weekly) output.weekly = weekly;
      if (monthly) output.monthly = monthly;
      // Legacy payloads never carry Zen windows — but tolerate them when present.
      const zenExtra: ZenWindows | null = extractZenWindows(record);
      if (zenExtra?.rolling && !output.rolling) output.rolling = zenExtra.rolling;
      return output;
    }
    // Zen Go shape: { usage: { rolling, weekly, monthly } } with
    // { status, percent, resetsAt } windows (percent → used/limit 100).
    // Anything else → 503, never a mock.
    if (typeof usage === "object" && usage !== null) {
      const zen: ZenWindows | null = extractZenWindows(record);
      if (zen) {
        const output: BillingUsage = { updatedAt: observedAt };
        if (zen.rolling) output.rolling = zen.rolling;
        // Legacy breakdown passthrough still honored when present.
        const daily: BillingLimitBucket | undefined = parseBucket(record["daily"]);
        if (daily) output.daily = daily;
        const legacyWeekly: BillingLimitBucket | undefined = parseBucket(record["weekly"]);
        const legacyMonthly: BillingLimitBucket | undefined = parseBucket(record["monthly"]);
        // Zen windows win for weekly/monthly (real upstream percent);
        // legacy used/limit pairs are fallback when Zen windows are absent.
        output.weekly = zen.weekly ?? legacyWeekly;
        output.monthly = zen.monthly ?? legacyMonthly;
        if (!output.rolling && !output.weekly && !output.monthly) {
          this.logger.warn(
            `[billing] getUsage shape mismatch status=${response.status} code=EXTERNAL_UNAVAILABLE`,
            correlationId,
          );
          throw new ExternalServiceError({
            code: "EXTERNAL_UNAVAILABLE",
            service: "billing",
            operation: "getUsage",
            message: "сервис временно недоступен, повторите позже",
            isRetryable: true,
          });
        }
        // Omit undefined keys so the envelope stays tight (no balance/usage
        // for Zen — the UI renders buckets only, never fake 0% bars).
        if (!output.weekly) delete output.weekly;
        if (!output.monthly) delete output.monthly;
        return output;
      }
    }
    this.logger.warn(
      `[billing] getUsage shape mismatch status=${response.status} code=EXTERNAL_UNAVAILABLE`,
      correlationId,
    );
    throw new ExternalServiceError({
      code: "EXTERNAL_UNAVAILABLE",
      service: "billing",
      operation: "getUsage",
      message: "сервис временно недоступен, повторите позже",
      isRetryable: true,
    });
  }
}
