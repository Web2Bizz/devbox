/**
 * Health + registry status contracts.
 *
 * Mirrors contracts/openapi.yaml components/schemas: Health,
 * RegistryCatalog, NpmRegistryStatus (field-for-field).
 * Previously duplicated in apps/backend/src/contracts.ts and
 * apps/frontend/src/api/types.ts — this package is the single source.
 */

/** GET /health (unversioned liveness probe) */
export type HealthResponse = {
  status: 'ok';
  /** postgres reachability: up | down | skipped (no DATABASE_URL / MVP boot without pg) */
  db: 'up' | 'down' | 'skipped';
  /** opencode server reachability: up (any HTTP response) | down (timeout/network) */
  opencode: 'up' | 'down';
  /** docker registry reachability: up | down | skipped (no DOCKER_REGISTRY_URL) */
  registry: 'up' | 'down' | 'skipped';
  /** npm registry (Verdaccio) reachability: up | down | skipped (no NPM_REGISTRY_URL) */
  npmRegistry: 'up' | 'down' | 'skipped';
};

/** GET /api/v1/registry/catalog — live Docker Registry /v2/_catalog (503 when unreachable) */
export type RegistryCatalogResponse = {
  repositories: string[];
};

/** GET /api/v1/registry/npm/status — live Verdaccio /-/ping reachability (503 when unreachable) */
export type NpmRegistryStatusResponse = {
  status: 'up';
  /** Canonical registry base URL, no trailing slash (never carries the token) */
  url: string;
  /** Observed npm scope, e.g. '@web2bizz' */
  scope: string;
};
