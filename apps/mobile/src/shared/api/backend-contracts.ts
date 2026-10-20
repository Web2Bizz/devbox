/**
 * Backend wire contracts for mobile — thin Forward-Only re-export of
 * `@devbox/contracts` (single source of truth, mirrors
 * contracts/openapi.yaml field-for-field; zod v4 boundary schemas verbatim
 * from the backend DTOs).
 *
 * Install: `npm install --legacy-peer-deps` from apps/mobile (standalone npm
 * project, `--legacy-peer-deps` required — see apps/mobile/AGENTS.md).
 * Resolve: `file:../../packages/contracts` in package.json (outside the
 * mobile root) + `metro.config.js` watchFolders/extraNodeModules +
 * `tsconfig.json` paths `@devbox/contracts` → package src. Primary runtime
 * resolve is node_modules after install; the Metro/TS aliases keep the
 * pre-install and bundler paths working.
 *
 * Why a shim (not a swap in sdk/index.ts): the opencode client in
 * `src/shared/utils/sdk` talks to the UPSTREAM opencode server directly
 * (`/global/health`, `/session`, `/project`, …) — its `Session` (slug /
 * projectID / directory / time), `Project` (path: { cwd, root, absolute })
 * and `HealthResponse` ({ healthy, version } = openapi `OpencodeHealth`) are
 * upstream shapes, NOT backend `/api/v1/*` wire. Swapping them for the
 * backend `Session` ({ id, title, createdAt }) / `Project` (backend row +
 * optional `scope`) / `HealthResponse` ({ status, db, opencode, … }) would
 * silently break the wire. Those sdk types stay intentionally untouched;
 * backend wire is imported FROM HERE when mobile starts speaking `/api/v1`.
 *
 * zod on the boundary (as backend): use the `*Schema.parse()` helpers below
 * (fail-fast, same constraints/messages as the backend) at every backend
 * response boundary — never trust-fetch without a schema.
 */
export type {
  ApiError,
  HealthResponse,
  Session as BackendSession,
  ChatMessage as BackendChatMessage,
  MessagesResponse as BackendMessagesResponse,
  Project as BackendProject,
  ProjectScope,
  Organization as BackendOrganization,
  OrganizationMember as BackendOrganizationMember,
  OrganizationInvite as BackendOrganizationInvite,
  OrgRole,
  OpencodeKeyStatus,
  OpencodeKeyResult,
  OpencodeKeyDeleteResult,
  OpencodeUsage,
  OpencodeLimitBucket,
} from "@devbox/contracts";

export {
  apiErrorSchema,
  healthResponseSchema,
  sessionSchema,
  messagesResponseSchema,
  projectSchema,
  projectScopeSchema,
  createProjectSchema,
  updateProjectSchema,
  organizationSchema,
  organizationMemberSchema,
  organizationInviteSchema,
  orgRoleSchema,
  createOrganizationSchema,
  updateOrganizationSchema,
  opencodeKeyStatusSchema,
  opencodeKeyResultSchema,
  opencodeKeyDeleteResultSchema,
  opencodeUsageSchema,
  opencodeLimitBucketSchema,
} from "@devbox/contracts";

import {
  apiErrorSchema,
  healthResponseSchema,
  opencodeUsageSchema,
  type ApiError,
  type HealthResponse,
  type OpencodeUsage,
} from "@devbox/contracts";

/** Fail-fast backend `/health` boundary (throws on shape mismatch, as backend). */
export function parseBackendHealth(payload: unknown): HealthResponse {
  return healthResponseSchema.parse(payload);
}

/** Fail-fast backend `GET /api/v1/usage` boundary (throws on shape mismatch). */
export function parseBackendUsage(payload: unknown): OpencodeUsage {
  return opencodeUsageSchema.parse(payload);
}

/** Fail-fast backend `ApiError` envelope boundary (frozen shape, values only). */
export function parseBackendApiError(payload: unknown): ApiError {
  return apiErrorSchema.parse(payload);
}
