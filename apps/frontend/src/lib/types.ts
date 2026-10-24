/**
 * Shared domain types for mocked dashboard pages.
 * Real API DTOs live in '@rush-code/contracts' (via src/api/types.ts
 * re-export) — these mirror the backend contracts so hooks can swap
 * mocks for `api.*` calls later.
 * TODO REAL-API: replace mock sources inside hooks with ApiClient calls.
 */

import type { ProjectScope } from '@rush-code/contracts';

export type ProjectStatus = 'active' | 'draft' | 'archived';

export type Project = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  /** ISO-8601 */
  updatedAt: string;
  repo?: string;
  /** True when the on-disk git repo is missing/invalid (backend-computed). */
  corrupted: boolean;
  /** Machine reason when corrupted (missing-dir, no-git, storage-unconfigured, …), null otherwise. */
  corruptedReason: string | null;
  /** Disk-home scope (user|org); optional — old caches/imports stay valid. */
  scope?: ProjectScope;
};

export type SecretItem = {
  id: string;
  name: string;
  projectId: string;
  /** Masked preview, e.g. `sk-••••1234` — never a real value. */
  maskedPreview: string;
  /** ISO-8601 */
  updatedAt: string;
};

export type Profile = {
  id: string;
  name: string;
  email: string;
  /** ISO-8601 */
  createdAt: string;
};

export type AiProviderStatus = 'connected' | 'disconnected' | 'error';

export type AiProvider = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: AiProviderStatus;
  modelsCount: number;
};

/**
 * Docker-registry surface (mirrors GET /health `registry` flag).
 * `up` = live catalog reachable, `down` = 503/unreachable,
 * `skipped` = DOCKER_REGISTRY_URL unset. Secrets never leave the backend
 * (env DOCKER_REGISTRY_*, never-logged) — the frontend stores name/url only.
 */
export type RegistryStatus = 'up' | 'down' | 'skipped';

export type RegistryItem = {
  id: string;
  name: string;
  /** Base URL, no trailing slash (display only, no secrets). */
  url: string;
  status: RegistryStatus;
  repositories?: string[];
};

/**
 * npm surface (mirrors GET /api/v1/registry/npm/status + /health `npmRegistry` flag).
 * `up` = live Verdaccio /-/ping reachable, `down` = 503/unreachable,
 * `skipped` = NPM_REGISTRY_URL unset. Token never leaves the backend
 * (env NPM_REGISTRY_*, never-logged) — the frontend stores url/scope only.
 */
export type NpmStatus = 'up' | 'down' | 'skipped';

export type NpmPackageItem = {
  id: string;
  name: string;
  /** Registry base URL (display only, no secrets). */
  url: string;
  /** Observed scope, e.g. '@web2bizz' (carries no secrets). */
  scope: string;
  status: NpmStatus;
};
