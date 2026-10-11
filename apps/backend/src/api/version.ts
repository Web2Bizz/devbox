import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation } from '@nestjs/swagger';

/**
 * API versioning contract — single source of truth.
 *
 * URL scheme (see app.setup.ts `configureApp`):
 * - canonical:  /api/v1/* via setGlobalPrefix('api') + URI versioning (default '1')
 * - removed:    unversioned /api/* aliases are gone → 404 { code: 'not_found', … }
 * - reserved:   /api/v2/* is intentionally unbound → 404 { code: 'not_found', … }
 * - /health stays VERSION_NEUTRAL at the root (global-prefix excluded; probes
 *   must not depend on API versioning).
 */
export const DEFAULT_API_VERSION = '1';

export const SUPPORTED_API_VERSIONS: readonly string[] = ['1'] as const;

/** Canonical v1 prefix (for docs, frontend client, openapi.yaml). */
export const API_V1_PREFIX = '/api/v1';

/**
 * Swagger + runtime headers for a canonical v1 endpoint.
 * Documents the effective URI version (no `Api-Version` request header is
 * required — versioning is encoded in the path).
 */
export function V1Endpoint(summary: string) {
  return applyDecorators(
    ApiOperation({ summary }),
    ApiHeader({
      name: 'Api-Version',
      required: false,
      description: `Effective URI API version (always "${DEFAULT_API_VERSION}" for this endpoint). Informational — not a request header.`,
      example: DEFAULT_API_VERSION,
    }),
  );
}
