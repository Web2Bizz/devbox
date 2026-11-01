/**
 * API versioning contract — single source of truth.
 *
 * URL scheme (see app/app.setup.ts `configureApp`):
 * - canonical:  /api/v1/* via setGlobalPrefix('api') + URI versioning with
 *   `defaultVersion: '1'` — every endpoint is v1 unless it opts out
 * - removed:    unversioned /api/* aliases are gone → 404 { code: 'not_found', … }
 * - reserved:   /api/v2/* is intentionally unbound → 404 { code: 'not_found', … }
 * - /health stays VERSION_NEUTRAL at the root (global-prefix excluded; probes
 *   must not depend on API versioning).
 *
 * `@Version(VERSION_NEUTRAL)` is the only explicit override controllers may
 * apply; there is no per-endpoint `Api-Version` request or response header —
 * the version is encoded in the URI alone.
 */
export const DEFAULT_API_VERSION = '1';

export const SUPPORTED_API_VERSIONS: readonly string[] = ['1'] as const;

/** Canonical v1 prefix (for docs, frontend client, openapi.yaml). */
export const API_V1_PREFIX = '/api/v1';
