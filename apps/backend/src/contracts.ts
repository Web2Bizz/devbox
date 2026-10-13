/**
 * Shared DTO contracts for the opencode proxy layer.
 *
 * NOTE: intentionally duplicated in apps/frontend/src/api/types.ts
 * (no cross-workspace imports — npm workspaces apps/* have no shared package).
 * No business logic here, only types + comments. Zod omitted on purpose:
 * not in dependencies, TS types are enough for the contract stage.
 */

/** GET /health (unversioned liveness probe) */
export interface HealthResponse {
  status: 'ok';
  /** postgres reachability: up | down | skipped (no DATABASE_URL / MVP boot without pg) */
  db: 'up' | 'down' | 'skipped';
  /** opencode server reachability: up (any HTTP response) | down (timeout/network) */
  opencode: 'up' | 'down';
  /** docker registry reachability: up | down | skipped (no DOCKER_REGISTRY_URL) */
  registry: 'up' | 'down' | 'skipped';
  /** npm registry (Verdaccio) reachability: up | down | skipped (no NPM_REGISTRY_URL) */
  npmRegistry: 'up' | 'down' | 'skipped';
}

/** GET /api/v1/registry/catalog — live Docker Registry /v2/_catalog (503 when unreachable) */
export interface RegistryCatalogResponse {
  repositories: string[];
}

/** GET /api/v1/registry/npm/status — live Verdaccio /-/ping reachability (503 when unreachable) */
export interface NpmRegistryStatusResponse {
  status: 'up';
  /** Canonical registry base URL, no trailing slash (never carries the token) */
  url: string;
  /** Observed npm scope, e.g. '@web2bizz' */
  scope: string;
}

/** GET /api/v1/session — live upstream session (503 when opencode unreachable) */
export interface Session {
  id: string;
  title: string;
  /** ISO-8601 timestamp */
  createdAt: string;
  /** model name when known */
  model?: string;
}

/** Single chat message */
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
  /** omit to let backend use the active upstream session */
  sessionId?: string;
  message: string;
}

/** POST /api/v1/chat response (live upstream reply; 503 when unreachable) */
export interface SendChatResponse {
  sessionId: string;
  /** assistant reply */
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

/** Unified error envelope for all /api/v1/* routes */
export interface ApiError {
  /**
   * machine-readable code: legacy lowercase (`bad_request` | `unauthorized` |
   * `forbidden` | `not_found` | `internal_error` | …) plus typed upstream
   * codes (`EXTERNAL_TIMEOUT` | `EXTERNAL_UNAVAILABLE` |
   * `EXTERNAL_RATE_LIMITED` | `EXTERNAL_UPSTREAM_5XX` | `GITHUB_AUTH`) plus
   * auth codes (`invalid_credentials` | `email_taken` | `provider_not_configured`).
   * Shape is frozen — only new code VALUES are added, never new fields.
   */
  code: string;
  /** human-readable message (no secrets) */
  message: string;
  /** echo of x-correlation-id / generated uuid for log tracing */
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

/** PUT /api/v1/opencode/key result (carries no secret). */
export interface OpencodeKeyResult {
  ok: boolean;
  /** ISO-8601 timestamp */
  updatedAt: string;
}

/** DELETE /api/v1/opencode/key result (idempotent, no timestamp). */
export interface OpencodeKeyDeleteResult {
  ok: boolean;
}

/** GET /api/v1/opencode/key — whether the caller has a key stored. */
export interface OpencodeKeyStatus {
  configured: boolean;
  /** ISO-8601 timestamp (present only when configured). */
  updatedAt?: string;
}

/** GET /api/v1/opencode/usage — live upstream balance+usage (no cache/TTL). */
export interface OpencodeUsage {
  balance: number;
  usage: number;
  /** ISO-8601 time of the upstream response */
  updatedAt: string;
}
