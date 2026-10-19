import { HttpException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AppLogger } from "../common/app-logger.service.js";
import { ExternalClient } from "../common/external/external-client.js";
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from "../common/external/external-error.js";
import { CryptoService } from "./crypto.service.js";
import { OpencodeKeysService } from "./opencode-keys.service.js";

/** GET /api/v1/usage response (Zen Go contract + legacy backward-compat). */
export interface OpencodeLimitBucket {
  used: number;
  limit: number;
}

export interface OpencodeUsage {
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
  rolling?: OpencodeLimitBucket;
  daily?: OpencodeLimitBucket;
  weekly?: OpencodeLimitBucket;
  monthly?: OpencodeLimitBucket;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBucket(value: unknown): OpencodeLimitBucket | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const used = rec["used"];
  const limit = rec["limit"];
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
function parseZenWindow(value: unknown): OpencodeLimitBucket | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const status = rec["status"];
  const percent = rec["percent"];
  const resetsAt = rec["resetsAt"];
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
function extractZenWindows(rec: Record<string, unknown>): {
  rolling?: OpencodeLimitBucket;
  weekly?: OpencodeLimitBucket;
  monthly?: OpencodeLimitBucket;
} | null {
  const nested =
    typeof rec["usage"] === "object" && rec["usage"] !== null
      ? (rec["usage"] as Record<string, unknown>)
      : null;
  const src = nested ?? rec;
  const rolling = parseZenWindow(src["rolling"]);
  const weekly = parseZenWindow(src["weekly"]);
  const monthly = parseZenWindow(src["monthly"]);
  if (!rolling && !weekly && !monthly) return null;
  const out: {
    rolling?: OpencodeLimitBucket;
    weekly?: OpencodeLimitBucket;
    monthly?: OpencodeLimitBucket;
  } = {};
  if (rolling) out.rolling = rolling;
  if (weekly) out.weekly = weekly;
  if (monthly) out.monthly = monthly;
  return out;
}

/**
 * Upstream usage endpoint (GET, per-user Bearer) — hard-coded module
 * constant. There is no env override (OPENCODE_BILLING_URL was removed from
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
export const OPENCODE_BILLING_URL = "https://opencode.ai/zen/go/v1/usage";

/**
 * OpencodeBillingService — live upstream usage for the caller's own key.
 *
 * - Loads the caller's row and decrypts it (missing → 404
 *   `opencode_key_missing` so clients can prompt key setup; undecryptable →
 *   500 from CryptoService). Rows wrapped with a stale KEK are lazily
 *   re-wrapped under the active KEK (best-effort, never fails the request).
 * - Raw GET fetch (no SDK — the SDK has no billing surface) to the
 *   module OPENCODE_BILLING_URL constant with per-user `Authorization:
 *   Bearer`, via
 *   ExternalClient (REQUEST_TIMEOUT_MS budget + EXTERNAL_RETRY_* tuning,
 *   service='opencode-billing'). updatedAt = upstream response time.
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
 *   (`[opencode-billing] getUsage … status=… code=…`), without stack and
 *   without URL/body/Bearer; stack/cause (if any) goes to debug only.
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
    return OPENCODE_BILLING_URL;
  }

  async getUsage(userId: string, correlationId?: string): Promise<OpencodeUsage> {
    const stored = await this.keys.findByUserId(userId, correlationId);
    if (!stored) {
      throw new NotFoundException({
        code: "opencode_key_missing",
        message: "No OpenCode API key configured for this user",
      });
    }
    // Decrypt in memory only for this request (dual-read across the KEK
    // rotation window via the row's keyId; legacy rows without an id fall
    // back to active → previous). The plaintext never leaves this method
    // except as the upstream Bearer, and is never logged.
    const apiKey = this.crypto.decrypt({
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
        const fresh = this.crypto.encrypt(apiKey);
        await this.keys.save(
          userId,
          { encryptedKey: fresh.data, iv: fresh.iv, keyId: fresh.keyId },
          correlationId,
        );
        this.logger.info("[opencode-billing] key re-encrypted", correlationId);
      } catch {
        this.logger.warn("[opencode-billing] lazy re-encrypt skipped", correlationId);
      }
    }

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
      // One-liner with operation/status/code, no stack, no secrets.
      this.logger.warn(
        `[opencode-billing] getUsage rejected status=${res.status} code=opencode_key_invalid`,
        correlationId,
      );
      throw new UnauthorizedException({
        code: "opencode_key_invalid",
        message: "OpenCode API key was rejected",
      });
    }
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      await res.arrayBuffer().catch(() => null);
      const mapped = fromStatus("opencode-billing", "getUsage", res.status);
      this.logger.warn(
        `[opencode-billing] getUsage upstream status=${res.status} code=${mapped.code}`,
        correlationId,
      );
      throw mapped;
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => null);
      const mapped = fromStatus("opencode-billing", "getUsage", res.status);
      this.logger.warn(
        `[opencode-billing] getUsage upstream status=${res.status} code=${mapped.code}`,
        correlationId,
      );
      throw mapped;
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      await res.arrayBuffer().catch(() => null);
      this.logger.warn(
        `[opencode-billing] getUsage bad json status=${res.status} code=EXTERNAL_UNAVAILABLE`,
        correlationId,
      );
      throw new ExternalServiceError({
        code: "EXTERNAL_UNAVAILABLE",
        service: "opencode-billing",
        operation: "getUsage",
        message: "сервис временно недоступен, повторите позже",
        isRetryable: true,
      });
    }
    const rec = payload as Record<string, unknown> | null;
    if (typeof rec !== "object" || rec === null) {
      this.logger.warn(
        `[opencode-billing] getUsage shape mismatch status=${res.status} code=EXTERNAL_UNAVAILABLE`,
        correlationId,
      );
      throw new ExternalServiceError({
        code: "EXTERNAL_UNAVAILABLE",
        service: "opencode-billing",
        operation: "getUsage",
        message: "сервис временно недоступен, повторите позже",
        isRetryable: true,
      });
    }
    // Legacy pay-as-you-go shape (backward-compat for old mocks): finite
    // top-level { balance, usage } numbers.
    const balance = rec["balance"];
    const usage = rec["usage"];
    if (isFiniteNumber(balance) && isFiniteNumber(usage)) {
      // Additive passthrough: finite { used, limit } pairs only, else omitted.
      const out: OpencodeUsage = { balance, usage, updatedAt: observedAt };
      const daily = parseBucket(rec["daily"]);
      const weekly = parseBucket(rec["weekly"]);
      const monthly = parseBucket(rec["monthly"]);
      if (daily) out.daily = daily;
      if (weekly) out.weekly = weekly;
      if (monthly) out.monthly = monthly;
      // Legacy payloads never carry Zen windows — but tolerate them when present.
      const zenExtra = extractZenWindows(rec);
      if (zenExtra?.rolling && !out.rolling) out.rolling = zenExtra.rolling;
      return out;
    }
    // Zen Go shape: { usage: { rolling, weekly, monthly } } with
    // { status, percent, resetsAt } windows (percent → used/limit 100).
    // Anything else → 503, never a mock.
    if (typeof usage === "object" && usage !== null) {
      const zen = extractZenWindows(rec);
      if (zen) {
        const out: OpencodeUsage = { updatedAt: observedAt };
        if (zen.rolling) out.rolling = zen.rolling;
        // Legacy breakdown passthrough still honored when present.
        const daily = parseBucket(rec["daily"]);
        if (daily) out.daily = daily;
        const legacyWeekly = parseBucket(rec["weekly"]);
        const legacyMonthly = parseBucket(rec["monthly"]);
        // Zen windows win for weekly/monthly (real upstream percent);
        // legacy used/limit pairs are fallback when Zen windows are absent.
        out.weekly = zen.weekly ?? legacyWeekly;
        out.monthly = zen.monthly ?? legacyMonthly;
        if (!out.rolling && !out.weekly && !out.monthly) {
          this.logger.warn(
            `[opencode-billing] getUsage shape mismatch status=${res.status} code=EXTERNAL_UNAVAILABLE`,
            correlationId,
          );
          throw new ExternalServiceError({
            code: "EXTERNAL_UNAVAILABLE",
            service: "opencode-billing",
            operation: "getUsage",
            message: "сервис временно недоступен, повторите позже",
            isRetryable: true,
          });
        }
        // Omit undefined keys so the envelope stays tight (no balance/usage
        // for Zen — the UI renders buckets only, never fake 0% bars).
        if (!out.weekly) delete out.weekly;
        if (!out.monthly) delete out.monthly;
        return out;
      }
    }
    this.logger.warn(
      `[opencode-billing] getUsage shape mismatch status=${res.status} code=EXTERNAL_UNAVAILABLE`,
      correlationId,
    );
    throw new ExternalServiceError({
      code: "EXTERNAL_UNAVAILABLE",
      service: "opencode-billing",
      operation: "getUsage",
      message: "сервис временно недоступен, повторите позже",
      isRetryable: true,
    });
  }
}
