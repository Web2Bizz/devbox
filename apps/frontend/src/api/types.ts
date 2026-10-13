/**
 * Shared DTO contracts (frontend copy).
 * Duplicated from apps/backend/src/contracts.ts — no cross-workspace imports.
 * No business logic, only types. Zod omitted (not a dependency).
 */

/** GET /health (unversioned liveness probe) */
export interface HealthResponse {
  status: 'ok';
  db: 'up' | 'down' | 'skipped';
  /** opencode server reachability: up | down */
  opencode: 'up' | 'down';
  /** docker registry reachability: up | down | skipped */
  registry: 'up' | 'down' | 'skipped';
  /** npm registry (Verdaccio) reachability: up | down | skipped */
  npmRegistry: 'up' | 'down' | 'skipped';
}

/** GET /api/v1/session */
export interface Session {
  id: string;
  title: string;
  /** ISO-8601 timestamp */
  createdAt: string;
  model?: string;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  /** ISO-8601 timestamp */
  createdAt: string;
}

/** POST /api/v1/chat request body */
export interface SendChatRequest {
  sessionId?: string;
  message: string;
}

/** POST /api/v1/chat response */
export interface SendChatResponse {
  sessionId: string;
  message: ChatMessage;
}

/** GET /api/v1/messages?sessionId=… */
export interface MessagesResponse {
  sessionId: string;
  messages: ChatMessage[];
}

/** GET /api/v1/repos + GET /api/v1/repos/:userSpace — readonly git-repo registry */
export interface RepoEntry {
  userSpace: string;
  name: string;
  /** Path relative to REPOS_ROOT, e.g. "alice/workspace/demo" */
  path: string;
  /** ISO-8601 mtime of the repo directory */
  updatedAt: string;
}

/** GET /api/v1/registry/catalog — live Docker Registry /v2/_catalog proxy.
 * 200 → { repositories: string[] }; unconfigured/unreachable → 503
 * EXTERNAL_UNAVAILABLE + Retry-After (no mock 200s). */
export interface RegistryCatalogResponse {
  repositories: string[];
}

/** GET /api/v1/registry/npm/status — live Verdaccio /-/ping reachability.
 * 200 → { status: 'up', url, scope }; unconfigured/unreachable → 503
 * EXTERNAL_UNAVAILABLE + Retry-After (no mock 200s, token never in payload). */
export interface NpmRegistryStatusResponse {
  status: 'up';
  url: string;
  scope: string;
}

/** Unified error envelope for all /api/v1/* routes */
export interface ApiError {
  code: string;
  message: string;
  correlationId: string;
}

/** POST /api/v1/auth/register + login response user (never carries passwordHash) */
export interface AuthUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  provider: 'local' | 'sso-oauth' | 'github-app';
  /** ISO-8601 timestamp */
  createdAt: string;
}

/** Token pair (short-lived access + rotating refresh). */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'bearer';
  /** Access lifetime in seconds. */
  expiresIn: number;
}

/** POST /api/v1/auth/register + login response (user + tokens). */
export interface AuthSession extends AuthTokens {
  user: AuthUser;
}

/** Projects — mirrors backend `Project` + DTOs (apps/backend/src/projects/*) */
export type ProjectScope = 'user' | 'org';

export interface ProjectApiDto {
  id: string;
  name: string;
  description: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  githubBranch: string | null;
  githubUrl: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Computed flag (no DB column): true when the on-disk git repo is missing/invalid. */
  corrupted: boolean;
  /** Machine reason when corrupted (missing-dir, no-git, rev-parse-failed, storage-unconfigured, …). */
  corruptedReason: string | null;
  /** Disk-home scope (REPOS_ROOT users/<uuid>/… vs orgs/<uuid>/…); optional — old caches stay valid. */
  scope?: ProjectScope;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  githubUrl?: string;
  ownerId?: string;
}

/**
 * Organizations — mirrors contracts/openapi.yaml (additive, verbatim).
 * /api/v1/organizations (CRUD, members only), /organizations/:id/members
 * (GET/POST; PATCH /members/:userId role; DELETE /members/:userId),
 * POST /organizations/:id/invites (single-use token + TTL),
 * POST /organizations/invites/accept {token},
 * POST/DELETE /organizations/:id/projects/:projectId.
 */
export interface OrganizationDto {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  isPrivate: boolean;
  /** ISO-8601 timestamp */
  createdAt: string;
  /** ISO-8601 timestamp */
  updatedAt: string;
}

export interface CreateOrganizationRequest {
  name: string;
  description?: string;
  isPrivate?: boolean;
}

export interface UpdateOrganizationRequest {
  name?: string;
  description?: string | null;
  isPrivate?: boolean;
}

export type OrgRole = 'maintainer' | 'user';

export interface MemberDto {
  orgId: string;
  userId: string;
  role: OrgRole;
  /** ISO-8601 timestamp */
  createdAt: string;
}

export interface AddMemberRequest {
  userId: string;
  role?: OrgRole;
}

export interface UpdateMemberRoleRequest {
  role: OrgRole;
}

/** Single-use bearer token — returned ONCE, never logged, TTL ORG_INVITE_TTL_SEC. */
export interface InviteDto {
  token: string;
  orgId: string;
  role: OrgRole;
  /** ISO-8601 timestamp */
  expiresAt: string;
}

export interface CreateInviteRequest {
  role?: OrgRole;
}

export interface AcceptInviteRequest {
  token: string;
}

/**
 * Per-user OpenCode keys — mirrors backend contracts.ts (additive, verbatim).
 * PUT/DELETE /api/v1/opencode/key (own key, encrypted at rest, never echoed),
 * GET /api/v1/opencode/key (existence only), GET /api/v1/opencode/usage
 * (live upstream { balance, usage, updatedAt }).
 */
export interface OpencodeKeyResult {
  ok: boolean;
  /** ISO-8601 timestamp */
  updatedAt: string;
}

export interface OpencodeKeyStatus {
  configured: boolean;
  /** ISO-8601 timestamp (present only when configured). */
  updatedAt?: string;
}

export interface OpencodeUsage {
  balance: number;
  usage: number;
  /** ISO-8601 time of the upstream response */
  updatedAt: string;
}
