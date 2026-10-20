/**
 * Per-user OpenCode key + usage contracts.
 *
 * Mirrors contracts/openapi.yaml components/schemas: OpencodeKeyResult,
 * OpencodeKeyDeleteResult, OpencodeKeyStatus, OpencodeUsage,
 * OpencodeLimitBucket (+ OpencodeKeyBody input). Key input type lives in
 * opencode-key.schema.ts (inferred from the backend-verbatim zod schema).
 * The key value itself is never returned or logged — only existence +
 * timestamps cross the wire.
 */

/** PUT /api/v1/key result (carries no secret). */
export type OpencodeKeyResult = {
  ok: boolean;
  /** ISO-8601 timestamp */
  updatedAt: string;
};

/** DELETE /api/v1/key result (idempotent, no timestamp). */
export type OpencodeKeyDeleteResult = {
  ok: boolean;
};

/** GET /api/v1/key — whether the caller has a key stored. */
export type OpencodeKeyStatus = {
  configured: boolean;
  /** ISO-8601 timestamp (present only when configured). */
  updatedAt?: string;
};

/** Single usage bucket — real `used/limit` pair from upstream (no derivation). */
export type OpencodeLimitBucket = {
  used: number;
  limit: number;
};

/** GET /api/v1/usage — live Zen Go usage (percent windows mapped to used/limit 100). */
export type OpencodeUsage = {
  /** Legacy pay-as-you-go fields — present only for legacy upstream payloads. */
  balance?: number;
  /** Legacy pay-as-you-go total — present only for legacy upstream payloads. */
  usage?: number;
  /** ISO-8601 time of the upstream response */
  updatedAt: string;
  /**
   * Zen Go windows mapped to used/limit (`percent` → `{ used: percent, limit: 100 }`).
   * `rolling` is the Zen 5-hour window (20% of monthly); legacy `daily` has
   * no Zen equivalent and is kept for old payloads. Present only when the
   * upstream payload carries finite numbers — never derived from a total.
   */
  rolling?: OpencodeLimitBucket;
  daily?: OpencodeLimitBucket;
  weekly?: OpencodeLimitBucket;
  monthly?: OpencodeLimitBucket;
};
