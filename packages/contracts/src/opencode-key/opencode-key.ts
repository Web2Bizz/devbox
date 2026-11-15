/**
 * OpenCode usage contracts (billing surface).
 *
 * Mirrors contracts/openapi.yaml components/schemas: OpencodeUsage,
 * OpencodeLimitBucket. Per-user API keys moved to the vault contracts
 * (`vault.ts`) — this module keeps only the read-only usage payload.
 */

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
