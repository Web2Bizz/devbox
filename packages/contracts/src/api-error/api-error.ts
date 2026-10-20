/**
 * Unified error envelope for all /api/v1/* routes.
 *
 * Mirrors contracts/openapi.yaml components/schemas ApiError.
 * Shape is FROZEN — only new `code` VALUES are added, never new fields.
 * Known code values (non-exhaustive): legacy lowercase (`bad_request` |
 * `unauthorized` | `forbidden` | `not_found` | `payload_too_large` |
 * `request_failed` | `internal_error`), typed upstream codes
 * (`EXTERNAL_TIMEOUT` | `EXTERNAL_UNAVAILABLE` | `EXTERNAL_RATE_LIMITED` |
 * `EXTERNAL_UPSTREAM_5XX` | `GITHUB_AUTH` | `GITHUB_NOT_INSTALLED`), auth
 * codes (`invalid_credentials` | `email_taken` | `provider_not_configured`),
 * key codes (`opencode_key_invalid` | `opencode_key_missing` |
 * `opencode_keys_unconfigured`).
 */
export type ApiError = {
  /** machine-readable code (see above — frozen shape, values only) */
  code: string;
  /** human-readable message (no secrets) */
  message: string;
  /** echo of x-correlation-id / generated uuid for log tracing */
  correlationId: string;
};
