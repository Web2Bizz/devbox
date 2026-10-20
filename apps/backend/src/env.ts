/**
 * Typed env contract — single source is the repo-root `.env.example`.
 * dotenv-expand is applied by main.ts BEFORE validation, so
 * ${VAR} / ${VAR:-default} interpolation has already happened here.
 *
 * Zod@4 schemas + ConfigModule.validate fail-fast. Never logs secrets
 * (DATABASE_URL / POSTGRES_PASSWORD never appear in messages or logs).
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { accessSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
  dirname,
  isAbsolute,
  resolve as resolvePath,
} from "node:path";

export type AppEnv = {
  backendPort: number;
  backendHost: string;
  backendProtocol: "http" | "https";
  /** Canonical socket, no trailing slash, e.g. http://localhost:3000 */
  backendSocket: string;
  /** Canonical opencode URL, no trailing slash, e.g. http://localhost:4096 */
  opencodeUrl: string;
  /** Optional bearer token for the opencode server ('' = unauthenticated; never logged). */
  opencodeToken: string;
  /**
   * Server secret for per-user OpenCode API-key encryption at rest
   * ('' = unconfigured — key endpoints answer 500; explicit values must be
   * ≥ 32 chars; never logged). This is the ACTIVE KEK: new rows are wrapped
   * with it under `opencodeKeysActiveKeyId`.
   */
  opencodeKeysEncryptionKey: string;
  /**
   * Previous KEK secret (rotation window only, '' = none). While set, rows
   * wrapped with the previous KEK stay readable (dual-read); the lazy +
   * background re-encrypt pass re-wraps them under the active KEK. Remove
   * once no stale rows remain. Explicit values must be ≥ 32 chars; never
   * logged.
   */
  opencodeKeysEncryptionKeyPrevious: string;
  /** Active KEK version id for new rows (default "v1"; stored plaintext). */
  opencodeKeysActiveKeyId: string;
  /** Previous KEK version id (default "v0"; stored plaintext, not a secret). */
  opencodeKeysPreviousKeyId: string;
  /** May be '' when no credentials/host configured — pg stub stays skipped. */
  databaseUrl: string;
  corsOrigins: string[];
  requestTimeoutMs: number;
  /** Total attempts for idempotent upstream calls (GET + 429/5xx/timeout). */
  externalRetryMaxAttempts: number;
  /** Retry backoff base in ms (doubles per attempt). */
  externalRetryBaseDelayMs: number;
  /** Retry backoff ceiling in ms. */
  externalRetryMaxDelayMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  nextPublicPort: number;
  /** GitHub App id ('' when unconfigured — /github/repos answers 401). */
  githubAppId: string;
  /** Normalized PEM private key ('' when unconfigured; never logged). */
  githubPrivateKey: string;
  /** Configured key file path ('' when inline key is used; never the key itself). */
  githubPrivateKeyPath: string;
  /**
   * Legacy single-installation id (dev fallback only, '' when unset).
   * Multi-tenant flow resolves the installation per user from stored
   * installations (callback/webhook); this stays only so a local dev
   * single-install keeps working without the install flow.
   * @deprecated Use per-user installations instead.
   */
  githubInstallationId: string;
  /** GitHub App slug for the install URL ('' when unconfigured). */
  githubAppSlug: string;
  /** Webhook secret for x-hub-signature-256 verify ('' = webhook disabled). */
  githubWebhookSecret: string;
  /** GitHub REST base URL, e.g. https://api.github.com (GHE override). */
  githubApiUrl: string;
  /** PROJECTS_ROOT jail root ('' = backend cwd fallback in ProjectFilesService). */
  projectsRoot: string;
  /**
   * REPOS_ROOT jail root for the git-repo tree
   * (REPOS_ROOT/<user-space>/workspace/<repo>). '' = unconfigured storage.
   *
   * Unified catalog: REPOS_ROOT is the SINGLE source of truth for READS and
   * WRITES. Empty REPOS_ROOT → reposRoot stays '' and boot logs an
   * [env] ERROR (storage unavailable: reads deny with 503, creates answer
   * 500). No silent fallback to <PROJECTS_ROOT>/repos or <cwd>/repos —
   * every storage READ gates on the explicit root and denies when it is
   * missing. Boot continues (health unchanged); the log states the outage
   * honestly. Set REPOS_ROOT in .env (see .env.example).
   */
  reposRoot: string;
  /** Resolved public backend URL for the frontend (explicit or backendSocket). */
  nextPublicApiUrl: string;
  /**
   * Docker Registry base URL, no trailing slash ('' = unconfigured —
   * registry endpoints answer 503, health flag is 'skipped').
   */
  dockerRegistryUrl: string;
  /** Registry basic-auth username ('' when unset/token mode; never logged). */
  dockerRegistryUser: string;
  /** Registry basic-auth password ('' when unset/token mode; never logged). */
  dockerRegistryPassword: string;
  /** Registry bearer token, wins over the basic pair when set (never logged). */
  dockerRegistryToken: string;
  /** Per-attempt budget ms for registry GET /v2/* calls. */
  dockerRegistryTimeoutMs: number;
  /** Total attempts for registry idempotent GET probes (429/5xx/timeout). */
  dockerRegistryRetryMaxAttempts: number;
  /** Registry retry backoff base in ms (doubles per attempt). */
  dockerRegistryRetryBaseDelayMs: number;
  /** Registry retry backoff ceiling in ms. */
  dockerRegistryRetryMaxDelayMs: number;
  /**
   * npm registry (Verdaccio) base URL, no trailing slash ('' = unconfigured —
   * npm status endpoint answers 503, health flag is 'skipped').
   */
  npmRegistryUrl: string;
  /**
   * npm registry bearer token (NPM_REGISTRY_TOKEN wins, legacy NPM_TOKEN
   * fallback for the bun-install token; '' = no Bearer — basic/anonymous
   * fallback applies; never logged).
   */
  npmRegistryToken: string;
  /** npm registry basic-auth username ('' when unset/token mode; never logged). */
  npmRegistryUser: string;
  /** npm registry basic-auth password ('' when unset/token mode; never logged). */
  npmRegistryPassword: string;
  /** npm scope observed by the module (default '@web2bizz'; never logged). */
  npmRegistryScope: string;
  /** Per-attempt budget ms for npm registry GET /-/ping calls. */
  npmRegistryTimeoutMs: number;
  /** Total attempts for npm registry idempotent GET probes (429/5xx/timeout). */
  npmRegistryRetryMaxAttempts: number;
  /** npm registry retry backoff base in ms (doubles per attempt). */
  npmRegistryRetryBaseDelayMs: number;
  /** npm registry retry backoff ceiling in ms. */
  npmRegistryRetryMaxDelayMs: number;
  /**
   * HS256 secret for short-lived access JWTs ('' = ephemeral dev secret +
   * boot WARN; explicit values must be ≥ 32 chars; never logged).
   */
  jwtAccessSecret: string;
  /** HS256 secret for rotating refresh JWTs (same rules as access). */
  jwtRefreshSecret: string;
  /** Access token lifetime in seconds (default 900 = 15m). */
  jwtAccessTtlSec: number;
  /** Refresh token lifetime in seconds (default 604800 = 7d). */
  jwtRefreshTtlSec: number;
  /**
   * Legacy x-user-id / ?userId mock identity fallback (dev default true +
   * WARN; explicit 'false' disables — JwtAuthGuard then requires Bearer).
   */
  authLegacyMockFallback: boolean;
  /**
   * Organization invite-token TTL in seconds (default 86400 = 24h).
   * Single-use invite tokens expire after this; per-invite override is
   * intentionally unsupported (one server-wide policy, auditable).
   */
  orgInviteTtlSec: number;
};

// --- zod@4 primitive schemas (Standard Schema compatible) --------------------

export const portSchema = z
  .string()
  .regex(/^\d+$/, { error: "must be a numeric port 1-65535" })
  .transform((raw) => Number(raw))
  .refine((n) => Number.isInteger(n) && n >= 1 && n <= 65535, {
    error: "must be a numeric port 1-65535",
  });

export const protocolSchema = z.enum(["http", "https"], {
  error: 'must be "http" or "https"',
});

export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const timeoutSchema = z
  .string()
  .regex(/^\d+$/, { error: "must be a non-negative integer ms" })
  .transform((raw) => Number(raw))
  .refine((n) => Number.isInteger(n) && n >= 0, {
    error: "must be a non-negative integer ms",
  });

function parseUrlOrNull(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** True for absolute http(s) URLs with a host (CORS origins are never secret-bearing). */
export function isHttpUrl(value: string): boolean {
  const parsed = parseUrlOrNull(value);
  return (
    !!parsed &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    Boolean(parsed.hostname)
  );
}

/** Generic valid-URL-with-host check (assertValidUrl reports the [env] errors). */
export const urlSchema = z.string().refine(
  (v) => {
    const parsed = parseUrlOrNull(v);
    return !!parsed && Boolean(parsed.hostname);
  },
  { error: "must be a valid URL with a host (see .env.example)" },
);

/** Explicit DATABASE_URL shape check (never echo the value — it carries credentials). */
export const databaseUrlSchema = z
  .string()
  .regex(/^postgres(ql)?:\/\/[^/\s]+/, {
    error: "must be a postgres://... URL (see .env.example)",
  });

/** CORS_ORIGINS raw string → trimmed non-empty entries, each an http(s) URL. */
export const corsOriginsSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .refine((origins) => origins.length > 0 && origins.every(isHttpUrl), {
    error:
      "must be a comma-separated list of valid http(s) URLs (see .env.example)",
  });

/** Raw process.env shape — every value is an optional string. */
export const envRawSchema = z.object({
  APP_BACKEND_PORT: z.string().optional(),
  PORT: z.string().optional(),
  APP_BACKEND_HOST: z.string().optional(),
  APP_BACKEND_PROTOCOL: z.string().optional(),
  APP_BACKEND_SOCKET: z.string().optional(),
  OPENCODE_URL: z.string().optional(),
  OPENCODE_SERVER_URL: z.string().optional(),
  OPENCODE_HOST: z.string().optional(),
  OPENCODE_PORT: z.string().optional(),
  OPENCODE_PROTOCOL: z.string().optional(),
  OPENCODE_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  POSTGRES_USER: z.string().optional(),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_DB: z.string().optional(),
  POSTGRES_HOST: z.string().optional(),
  POSTGRES_PORT: z.string().optional(),
  PROJECTS_ROOT: z.string().optional(),
  REPOS_ROOT: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  REQUEST_TIMEOUT_MS: z.string().optional(),
  EXTERNAL_RETRY_MAX_ATTEMPTS: z.string().optional(),
  EXTERNAL_RETRY_BASE_DELAY_MS: z.string().optional(),
  EXTERNAL_RETRY_MAX_DELAY_MS: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
  NEXT_PUBLIC_PORT: z.string().optional(),
  NEXT_PUBLIC_API_URL: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_API_URL: z.string().optional(),
  DOCKER_REGISTRY_URL: z.string().optional(),
  DOCKER_REGISTRY_USER: z.string().optional(),
  DOCKER_REGISTRY_PASSWORD: z.string().optional(),
  DOCKER_REGISTRY_TOKEN: z.string().optional(),
  DOCKER_REGISTRY_TIMEOUT_MS: z.string().optional(),
  DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS: z.string().optional(),
  DOCKER_REGISTRY_RETRY_BASE_DELAY_MS: z.string().optional(),
  DOCKER_REGISTRY_RETRY_MAX_DELAY_MS: z.string().optional(),
  NPM_REGISTRY_URL: z.string().optional(),
  NPM_REGISTRY_TOKEN: z.string().optional(),
  /** Legacy bun-install token — kept for .npmrc/bunfig expansion; module fallback only. */
  NPM_TOKEN: z.string().optional(),
  NPM_REGISTRY_USER: z.string().optional(),
  NPM_REGISTRY_PASSWORD: z.string().optional(),
  NPM_REGISTRY_SCOPE: z.string().optional(),
  NPM_REGISTRY_TIMEOUT_MS: z.string().optional(),
  NPM_REGISTRY_RETRY_MAX_ATTEMPTS: z.string().optional(),
  NPM_REGISTRY_RETRY_BASE_DELAY_MS: z.string().optional(),
  NPM_REGISTRY_RETRY_MAX_DELAY_MS: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  JWT_ACCESS_TTL: z.string().optional(),
  JWT_REFRESH_TTL: z.string().optional(),
  AUTH_LEGACY_MOCK_FALLBACK: z.string().optional(),
  ORG_INVITE_TTL_SEC: z.string().optional(),
  OPENCODE_KEYS_ENCRYPTION_KEY: z.string().optional(),
  OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  OPENCODE_KEYS_ACTIVE_KEY_ID: z.string().optional(),
  OPENCODE_KEYS_PREVIOUS_KEY_ID: z.string().optional(),
});

export type EnvRaw = z.infer<typeof envRawSchema>;

/** Default GitHub REST base URL (GHE override via GITHUB_API_URL). */
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

/** Defaults for idempotent upstream retry (withRetry + ExternalClient). */
export const DEFAULT_EXTERNAL_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_EXTERNAL_RETRY_BASE_DELAY_MS = 200;
export const DEFAULT_EXTERNAL_RETRY_MAX_DELAY_MS = 2000;

/** Defaults for the docker-registry surface (mirrors EXTERNAL_RETRY_*). */
export const DEFAULT_DOCKER_REGISTRY_TIMEOUT_MS = 10000;
export const DEFAULT_DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_DOCKER_REGISTRY_RETRY_BASE_DELAY_MS = 200;
export const DEFAULT_DOCKER_REGISTRY_RETRY_MAX_DELAY_MS = 2000;

/** Default npm scope observed by the npm-registry module. */
export const DEFAULT_NPM_REGISTRY_SCOPE = "@web2bizz";

/** Default JWT lifetimes (access 15m, refresh 7d, in seconds). */
export const DEFAULT_JWT_ACCESS_TTL_SEC = 900;
export const DEFAULT_JWT_REFRESH_TTL_SEC = 604800;

/** Default organization invite-token TTL (24h, in seconds). */
export const DEFAULT_ORG_INVITE_TTL_SEC = 86400;

/** Minimum OPENCODE_KEYS_ENCRYPTION_KEY length (AES-256 key material, SHA-256 derived). */
export const MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH = 32;

/** Default KEK version id for newly wrapped rows (stored plaintext, not a secret). */
export const DEFAULT_OPENCODE_KEYS_ACTIVE_KEY_ID = "v1";

/** Default previous-KEK version id (rotation window only; not a secret). */
export const DEFAULT_OPENCODE_KEYS_PREVIOUS_KEY_ID = "v0";

/**
 * Allowed KEK version-id shape: leading alnum + up to 31 alnum/`_`/`-`
 * (e.g. "v1", "2026-10"). Ids travel in plaintext (`key_id` column), so the
 * rule only keeps them greppable and SQL-safe.
 */
export const OPENCODE_KEYS_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Minimum explicit JWT secret length (dev ephemeral fallback bypasses this). */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Ephemeral dev JWT secrets (unset JWT_*_SECRET → random per boot, cached).
 * Values never leave this module except as signing keys — never logged.
 */
const ephemeralSecrets = new Map<string, string>();

export function ephemeralDevJwtSecret(kind: "access" | "refresh"): string {
  let s = ephemeralSecrets.get(kind);
  if (!s) {
    s = randomBytes(48).toString("base64url");
    ephemeralSecrets.set(kind, s);
  }
  return s;
}

/** Test seam — drops ephemeral dev secrets (fresh randomness next call). */
export function clearEphemeralDevJwtSecretsForTests(): void {
  ephemeralSecrets.clear();
}

/** Defaults for the npm-registry surface (mirrors EXTERNAL_RETRY_*). */
export const DEFAULT_NPM_REGISTRY_TIMEOUT_MS = 10000;
export const DEFAULT_NPM_REGISTRY_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_NPM_REGISTRY_RETRY_BASE_DELAY_MS = 200;
export const DEFAULT_NPM_REGISTRY_RETRY_MAX_DELAY_MS = 2000;

/**
 * Normalizes a GitHub App private key from env.
 * Accepts raw PEM (possibly with literal `\n` escapes or surrounding quotes
 * from compose/pm2 interpolation) or base64-encoded PEM. Never throws on
 * content — validation of the key shape happens at JWT-sign time.
 */
export function normalizeGithubPrivateKey(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  if (key.includes("\\n")) key = key.replace(/\\n/g, "\n");
  if (!key.includes("BEGIN")) {
    const compact = key.replace(/\s+/g, "");
    if (compact.length >= 16) {
      try {
        const decoded = Buffer.from(compact, "base64").toString("utf8");
        if (decoded.includes("BEGIN")) return decoded.trim();
      } catch {
        // keep raw — sign step reports the failure without echoing content
      }
    }
  }
  return key;
}

/** True when the GitHub App pair is present (repos endpoint live per-install). */
export function isGithubConfigured(env: AppEnv): boolean {
  return Boolean(env.githubAppId && env.githubPrivateKey);
}

/** True when a registry base URL is configured (health flag up/down, else skipped). */
export function isDockerRegistryConfigured(env: AppEnv): boolean {
  return Boolean(env.dockerRegistryUrl);
}

/** True when an npm registry base URL is configured (health flag up/down, else skipped). */
export function isNpmRegistryConfigured(env: AppEnv): boolean {
  return Boolean(env.npmRegistryUrl);
}

/**
 * Resolves the private key: file path wins when GITHUB_APP_PRIVATE_KEY_PATH
 * is set (avoids multiline quoted PEM breaking dotenv parsers), otherwise
 * falls back to the inline GITHUB_APP_PRIVATE_KEY (raw PEM or base64).
 *
 * Relative paths are probed against several bases because the backend cwd
 * depends on the launcher: `bun run dev` from the repo root uses the root,
 * while pm2 (`ecosystem.config.cjs`, `cwd: ./apps/backend`) uses
 * `apps/backend`. Probing order: absolute path as-is (when absolute),
 * then `process.cwd()`, then its parents up to the repo root and above
 * (covers both `./keys/x.pem` from root and from `apps/backend`), then
 * module-dir derived bases (`__dirname`-relative, covers compiled `dist/`
 * layouts). The first existing file wins. Never logs content — errors carry
 * only the configured path plus the tried bases, never the key.
 */
export function resolveGithubPrivateKey(
  inlineRaw: string,
  pathRaw: string,
): string {
  const p = pathRaw.trim();
  if (p) {
    // Absolute path: single candidate, no base probing.
    if (isAbsolute(p)) {
      let content: string;
      try {
        content = readFileSync(p, "utf8");
      } catch {
        throw new Error(
          `[env] GITHUB_APP_PRIVATE_KEY_PATH points to an unreadable file: ${JSON.stringify(p)}. ` +
            `Check the path and file permissions (see .env.example).`,
        );
      }
      return normalizeGithubPrivateKey(content);
    }
    const bases: string[] = [];
    const pushBase = (b: string) => {
      if (b && !bases.includes(b)) bases.push(b);
    };
    // 1) launcher cwd + walk up (repo root is ≤2 levels above apps/backend).
    let dir = resolvePath(process.cwd());
    pushBase(dir);
    for (let i = 0; i < 4; i++) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      pushBase(dir);
    }
    // 2) module-dir derived bases (compiled dist/: apps/backend/dist → root
    //    is 3 levels up; ts-node src/: apps/backend/src → root is 2 up).
    const moduleDir: string | undefined =
      typeof __dirname !== "undefined" ? __dirname : undefined;
    if (moduleDir) {
      let m = resolvePath(moduleDir);
      pushBase(m);
      for (let i = 0; i < 4; i++) {
        const parent = dirname(m);
        if (parent === m) break;
        m = parent;
        pushBase(m);
      }
    }
    const candidates = bases.map((b) => resolvePath(b, p));
    const tried: string[] = [];
    for (const abs of candidates) {
      if (tried.includes(abs)) continue;
      tried.push(abs);
      if (existsSync(abs)) {
        return normalizeGithubPrivateKey(readFileSync(abs, "utf8"));
      }
    }
    throw new Error(
      `[env] GITHUB_APP_PRIVATE_KEY_PATH points to an unreadable file: ${JSON.stringify(p)}. ` +
        `Tried ${tried.length} location(s): ${tried.map((t) => JSON.stringify(t)).join(", ")}. ` +
        `Check the path and file permissions (see .env.example).`,
    );
  }
  return inlineRaw ? normalizeGithubPrivateKey(inlineRaw) : "";
}

// --- helpers (no secrets in errors) ------------------------------------------

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const v of values) {
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return "";
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function assertValidUrl(value: string, name: string): string {
  const clean = stripSlash(value);
  const parsed = parseUrlOrNull(clean);
  if (!parsed || !urlSchema.safeParse(clean).success) {
    if (parsed && !parsed.hostname) {
      throw new Error(
        `[env] ${name} has an empty host: ${JSON.stringify(clean)}. ` +
          `Empty HOST interpolates to "http://:port" — set ${
            name.includes("OPENCODE") ? "OPENCODE_HOST" : "APP_BACKEND_HOST"
          } or leave the composite unset.`,
      );
    }
    throw new Error(
      `[env] ${name} is not a valid URL: ${JSON.stringify(clean)}. ` +
        `Check your .env (see .env.example).`,
    );
  }
  return clean;
}

/** Detects broken `${PROTO}://${HOST}:${PORT}` expansion with empty HOST. */
function looksBroken(url: string): boolean {
  return url.includes("://:") || url.endsWith("://");
}

function parsePortWithZod(raw: string, name: string): number {
  const parsed = portSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[env] ${name} must be a numeric port 1-65535, got ${JSON.stringify(raw)}. ` +
        `Check your .env (see .env.example).`,
    );
  }
  return parsed.data;
}

function parseProtocolWithZod(raw: string, name: string): "http" | "https" {
  const v = raw.trim().toLowerCase();
  const parsed = protocolSchema.safeParse(v);
  if (!parsed.success) {
    throw new Error(
      `[env] ${name} must be "http" or "https", got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed.data;
}

/** Known keys = envRawSchema shape; unknown keys with an app prefix are likely typos. */
const KNOWN_ENV_KEYS: ReadonlySet<string> = new Set(
  Object.keys(envRawSchema.shape),
);

const APP_ENV_PREFIXES = [
  "APP_BACKEND_",
  "OPENCODE_",
  "POSTGRES_",
  "DATABASE_URL",
  "CORS_",
  "REQUEST_TIMEOUT_MS",
  "EXTERNAL_",
  "LOG_LEVEL",
  "NEXT_PUBLIC_",
  "GITHUB_",
  "DOCKER_",
  "DOCKER_REGISTRY_",
  "NPM_",
  "NPM_REGISTRY_",
  "JWT_",
  "JWT_ACCESS_",
  "JWT_REFRESH_",
  "AUTH_",
  "AUTH_LEGACY_",
  "ORG_",
  "PROJECTS_ROOT",
  "REPOS_ROOT",
  "REPOS_",
] as const;

/** App-prefixed keys outside the known contract (probable typos) — unrelated OS vars ignored. */
export function findSuspiciousUnknownKeys(source: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const key of Object.keys(source)) {
    if (KNOWN_ENV_KEYS.has(key)) continue;
    if (APP_ENV_PREFIXES.some((p) => key === p || key.startsWith(p)))
      out.push(key);
  }
  return out.sort();
}

export type EnvValidation = {
  env: AppEnv;
  /**
   * Non-fatal notices (`[env] WARN ...`, never fatal, never secret-bearing).
   * Collected — not logged — so per-request validateEnv() callers stay quiet;
   * main.ts logs them once at boot via AppLogger.
   */
  warnings: string[];
};

export function validateEnvWithWarnings(
  source: NodeJS.ProcessEnv = process.env,
): EnvValidation {
  const warnings: string[] = [];
  const warn = (msg: string): void => {
    warnings.push(msg);
  };

  // Structural check via zod@4 (Standard Schema) — rejects non-string values early.
  const rawCheck = envRawSchema.safeParse(source);
  if (!rawCheck.success) {
    throw new Error(
      `[env] invalid environment shape: ${rawCheck.error.issues[0]?.message}`,
    );
  }
  const env = rawCheck.data;

  // --- backend socket -------------------------------------------------------
  const backendPortRaw = firstNonEmpty(env.APP_BACKEND_PORT, env.PORT);
  if (!backendPortRaw) {
    throw new Error(
      "[env] APP_BACKEND_PORT is required (legacy fallback: PORT). " +
        "Set APP_BACKEND_PORT=3000 in your .env (see .env.example).",
    );
  }
  const backendPort = parsePortWithZod(backendPortRaw, "APP_BACKEND_PORT");
  const backendHostRaw = firstNonEmpty(env.APP_BACKEND_HOST);
  const backendHost = backendHostRaw || "localhost"; // readonly-исключение: dev-listen default + WARN ниже (громко, не тихо); прод задаёт явно
  if (!backendHostRaw) {
    warn(
      '[env] WARN APP_BACKEND_HOST is empty, falling back to "localhost" (dev default). ' +
        "Set it explicitly for production (see .env.example).",
    );
  }
  const backendProtocol = parseProtocolWithZod(
    firstNonEmpty(env.APP_BACKEND_PROTOCOL) || "http",
    "APP_BACKEND_PROTOCOL",
  );
  const socketRaw = firstNonEmpty(env.APP_BACKEND_SOCKET);
  let backendSocket: string;
  if (socketRaw && !looksBroken(socketRaw)) {
    backendSocket = assertValidUrl(socketRaw, "APP_BACKEND_SOCKET");
  } else {
    if (socketRaw && looksBroken(socketRaw)) {
      warn(
        "[env] WARN APP_BACKEND_SOCKET looks broken (empty host from ${...} " +
          "interpolation with empty APP_BACKEND_HOST), recomposing from " +
          "APP_BACKEND_PROTOCOL/HOST/PORT (see .env.example).",
      );
    }
    backendSocket = assertValidUrl(
      `${backendProtocol}://${backendHost}:${backendPort}`,
      "APP_BACKEND_SOCKET (composed)",
    );
  }

  // --- opencode URL (optional service, 503 when unreachable) ----------------
  // NOTE: an explicit OPENCODE_HOST=0.0.0.0 is preserved verbatim in the
  // composed URL (the stand listens on all interfaces) — only an EMPTY host
  // falls back to 'localhost'. Outbound dialing remaps 0.0.0.0 → 127.0.0.1
  // inside OpencodeService.dialUrl(); env assembly never rewrites the host.
  const opencodeUrlRaw = firstNonEmpty(
    env.OPENCODE_URL,
    env.OPENCODE_SERVER_URL,
  );
  let opencodeUrl: string;
  if (opencodeUrlRaw && !looksBroken(opencodeUrlRaw)) {
    opencodeUrl = assertValidUrl(opencodeUrlRaw, "OPENCODE_URL");
  } else {
    if (opencodeUrlRaw && looksBroken(opencodeUrlRaw)) {
      warn(
        "[env] WARN OPENCODE_URL looks broken (empty host from ${...} interpolation), " +
          "recomposing from OPENCODE_PROTOCOL/HOST/PORT (see .env.example).",
      );
    }
    const ocHostRaw = firstNonEmpty(env.OPENCODE_HOST);
    const ocHost = ocHostRaw || "localhost"; // readonly-исключение: dev-dial default + WARN ниже (опциональный сервис, 503 при недоступности)
    if (!ocHostRaw) {
      warn(
        '[env] WARN OPENCODE_HOST is empty, falling back to "localhost" (dev default). ' +
          "Set it explicitly for production (see .env.example).",
      );
    }
    const ocProto = parseProtocolWithZod(
      firstNonEmpty(env.OPENCODE_PROTOCOL) || "http",
      "OPENCODE_PROTOCOL",
    );
    const ocPortRaw = firstNonEmpty(env.OPENCODE_PORT);
    const ocPort = ocPortRaw
      ? parsePortWithZod(ocPortRaw, "OPENCODE_PORT")
      : 4096; // dev default
    if (!ocPortRaw) {
      warn(
        "[env] WARN OPENCODE_PORT is unset, falling back to 4096 (dev default) " +
          "(see .env.example).",
      );
    }
    opencodeUrl = assertValidUrl(
      `${ocProto}://${ocHost}:${ocPort}`,
      "OPENCODE_URL (composed)",
    );
  }

  // --- opencode auth (optional bearer; never echoed in errors/logs) ----------
  const opencodeToken = firstNonEmpty(env.OPENCODE_TOKEN);

  // --- per-user OpenCode keys (encryption secret + billing endpoint) ---------
  // The encryption secret is REQUIRED for key storage but stays optional at
  // boot (fail-fast happens at use-time in CryptoService, never here): an
  // unset secret WARNs and key endpoints answer 500 opencode_keys_unconfigured
  // instead of breaking every other suite at boot. An explicit secret shorter
  // than 32 chars is ERROR (value never echoed — it is key material).
  // Rotation (no downtime): deploy the new secret as
  // OPENCODE_KEYS_ENCRYPTION_KEY (+ OPENCODE_KEYS_ACTIVE_KEY_ID) and keep the
  // old one as OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS (+
  // OPENCODE_KEYS_PREVIOUS_KEY_ID) — dual-read keeps old rows decryptable
  // while the lazy + `keys:reencrypt` background pass re-wraps them under the
  // active KEK; drop the previous secret once no stale rows remain.
  const keyIdOr = (raw: string | undefined, fallback: string, name: string): string => {
    const id = (raw ?? "").trim() || fallback;
    if (!OPENCODE_KEYS_KEY_ID_PATTERN.test(id)) {
      throw new Error(
        `[env] ${name} must match ${OPENCODE_KEYS_KEY_ID_PATTERN} (e.g. "v2"), got ${JSON.stringify(raw ?? "")}. ` +
          "Check your .env (see .env.example).",
      );
    }
    return id;
  };
  const opencodeKeysActiveKeyId = keyIdOr(
    firstNonEmpty(env.OPENCODE_KEYS_ACTIVE_KEY_ID),
    DEFAULT_OPENCODE_KEYS_ACTIVE_KEY_ID,
    "OPENCODE_KEYS_ACTIVE_KEY_ID",
  );
  const opencodeKeysPreviousKeyId = keyIdOr(
    firstNonEmpty(env.OPENCODE_KEYS_PREVIOUS_KEY_ID),
    DEFAULT_OPENCODE_KEYS_PREVIOUS_KEY_ID,
    "OPENCODE_KEYS_PREVIOUS_KEY_ID",
  );
  const opencodeKeysEncryptionKeyRaw = firstNonEmpty(
    env.OPENCODE_KEYS_ENCRYPTION_KEY,
  );
  let opencodeKeysEncryptionKey = "";
  if (opencodeKeysEncryptionKeyRaw) {
    if (
      opencodeKeysEncryptionKeyRaw.length <
      MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH
    ) {
      throw new Error(
        `[env] OPENCODE_KEYS_ENCRYPTION_KEY must be at least ${MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH} chars (see .env.example).`,
      );
    }
    opencodeKeysEncryptionKey = opencodeKeysEncryptionKeyRaw;
  } else {
    warn(
      "[env] WARN OPENCODE_KEYS_ENCRYPTION_KEY is not configured — " +
        "per-user OpenCode key endpoints answer 500 opencode_keys_unconfigured. " +
        "Set it explicitly (see .env.example).",
    );
  }
  // Previous KEK (rotation window only): unset is the normal steady state
  // (no WARN); set-but-short is ERROR (fail-closed, value never echoed).
  const opencodeKeysEncryptionKeyPreviousRaw = firstNonEmpty(
    env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS,
  );
  let opencodeKeysEncryptionKeyPrevious = "";
  if (opencodeKeysEncryptionKeyPreviousRaw) {
    if (
      opencodeKeysEncryptionKeyPreviousRaw.length <
      MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH
    ) {
      throw new Error(
        `[env] OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS must be at least ${MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH} chars (see .env.example).`,
      );
    }
    opencodeKeysEncryptionKeyPrevious = opencodeKeysEncryptionKeyPreviousRaw;
    warn(
      "[env] WARN OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS is set (rotation window) — " +
        "finish the lazy/background re-encrypt pass, then remove it (see .env.example).",
    );
  }
  // --- database --------------------------------------------------------------
  // NOTE: explicit value passes through untouched; never echoed in errors/logs.
  const explicitDb = firstNonEmpty(env.DATABASE_URL);
  let databaseUrl = "";
  if (explicitDb) {
    if (!databaseUrlSchema.safeParse(explicitDb).success) {
      throw new Error(
        "[env] DATABASE_URL has an unsupported shape — must be a postgres://... URL. " +
          "Check your .env (see .env.example).",
      );
    }
    databaseUrl = explicitDb;
  } else {
    const user = firstNonEmpty(env.POSTGRES_USER);
    const db = firstNonEmpty(env.POSTGRES_DB);
    if (user && db) {
      const pass = firstNonEmpty(env.POSTGRES_PASSWORD);
      const hostRaw = firstNonEmpty(env.POSTGRES_HOST);
      const host = hostRaw || "localhost"; // readonly-исключение: dev-dial default + WARN ниже; пустой DATABASE_URL+POSTGRES_* → databaseUrl="" + WARN + 503 (fail-fast на запросе, без тихого успеха)
      if (!hostRaw) {
        warn(
          '[env] WARN POSTGRES_HOST is empty, falling back to "localhost" (dev default). ' +
            "Set it explicitly for production (see .env.example).",
        );
      }
      const portRawSrc = firstNonEmpty(env.POSTGRES_PORT);
      const portRaw = portRawSrc || "5432";
      if (!portRawSrc) {
        warn(
          "[env] WARN POSTGRES_PORT is unset, falling back to 5432 (dev default) " +
            "(see .env.example).",
        );
      }
      const port = parsePortWithZod(portRaw, "POSTGRES_PORT");
      const creds = pass
        ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
        : `${encodeURIComponent(user)}@`;
      databaseUrl = `postgres://${creds}${host}:${port}/${encodeURIComponent(db)}`;
    }
    if (!databaseUrl) {
      warn(
        "[env] WARN no database configured (DATABASE_URL and POSTGRES_* are empty) — " +
          "Postgres operations will answer 503 EXTERNAL_UNAVAILABLE (see .env.example).",
      );
    }
    // else: composed from POSTGRES_* (MVP boots w/o explicit DATABASE_URL)
  }

  // --- cors -------------------------------------------------------------------
  // readonly-исключение: NEXT_PUBLIC_PORT-дефолт 3001 и CORS-дефолт ниже — read-конфиг
  // (allowlist для чтения; неверный CORS не пишет данные — браузер блокирует ответ).
  const nextPortRaw = firstNonEmpty(env.NEXT_PUBLIC_PORT) || "3001";
  const nextPublicPort = parsePortWithZod(nextPortRaw, "NEXT_PUBLIC_PORT");
  const corsRaw = firstNonEmpty(env.CORS_ORIGINS);
  let corsOrigins: string[];
  if (corsRaw) {
    const corsParsed = corsOriginsSchema.safeParse(corsRaw);
    if (!corsParsed.success) {
      const entries = corsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const badIdx = entries.findIndex((e) => !isHttpUrl(e));
      const at = badIdx >= 0 ? ` entry #${badIdx + 1}` : "";
      const shown = badIdx >= 0 ? `: ${JSON.stringify(entries[badIdx])}` : "";
      throw new Error(
        `[env] CORS_ORIGINS${at} is not a valid http(s) URL${shown}. ` +
          "Set CORS_ORIGINS as a comma-separated list of URLs (see .env.example).",
      );
    }
    corsOrigins = corsParsed.data;
  } else {
    corsOrigins = [
      `http://localhost:${nextPublicPort}`,
      "http://localhost:8080",
    ];
  }

  // --- misc ---------------------------------------------------------------------
  // readonly-исключение: REQUEST_TIMEOUT_MS-дефолт — тюнинг чтения upstream
  // (бюджет попытки; не путь записи на диск/БД).
  const timeoutRaw = firstNonEmpty(env.REQUEST_TIMEOUT_MS) || "10000";
  const timeoutParsed = timeoutSchema.safeParse(timeoutRaw);
  if (!timeoutParsed.success) {
    throw new Error(
      `[env] REQUEST_TIMEOUT_MS must be a non-negative integer ms, got ${JSON.stringify(timeoutRaw)}.`,
    );
  }
  const requestTimeoutMs = timeoutParsed.data;

  // --- external retry (silent dev defaults; ERROR only on explicit garbage) --
  // readonly-исключение: EXTERNAL_RETRY_*-дефолты — тюнинг чтения upstream GET
  // (попытки/бэкофф; явный мусор → ERROR выше через retryInt, тишины нет).
  const retryInt = (
    raw: string,
    name: string,
    unit: string,
    min: number,
    max: number,
  ): number => {
    const parsed = timeoutSchema.safeParse(raw);
    if (!parsed.success || parsed.data < min || parsed.data > max) {
      throw new Error(
        `[env] ${name} must be an integer ${min}-${max}${unit}, got ${JSON.stringify(raw)}. ` +
          `Check your .env (see .env.example).`,
      );
    }
    return parsed.data;
  };
  const retryMaxRaw = firstNonEmpty(env.EXTERNAL_RETRY_MAX_ATTEMPTS);
  const externalRetryMaxAttempts = retryMaxRaw
    ? retryInt(retryMaxRaw, "EXTERNAL_RETRY_MAX_ATTEMPTS", "", 1, 10)
    : DEFAULT_EXTERNAL_RETRY_MAX_ATTEMPTS;
  const retryBaseRaw = firstNonEmpty(env.EXTERNAL_RETRY_BASE_DELAY_MS);
  const externalRetryBaseDelayMs = retryBaseRaw
    ? retryInt(retryBaseRaw, "EXTERNAL_RETRY_BASE_DELAY_MS", " ms", 0, 60000)
    : DEFAULT_EXTERNAL_RETRY_BASE_DELAY_MS;
  const retryMaxDelayRaw = firstNonEmpty(env.EXTERNAL_RETRY_MAX_DELAY_MS);
  const externalRetryMaxDelayMs = retryMaxDelayRaw
    ? retryInt(retryMaxDelayRaw, "EXTERNAL_RETRY_MAX_DELAY_MS", " ms", 0, 60000)
    : DEFAULT_EXTERNAL_RETRY_MAX_DELAY_MS;
  if (externalRetryMaxDelayMs < externalRetryBaseDelayMs) {
    warn(
      "[env] WARN EXTERNAL_RETRY_MAX_DELAY_MS is below EXTERNAL_RETRY_BASE_DELAY_MS — " +
        "the backoff ceiling clamps to the base (see .env.example).",
    );
  }
  const levelSrc = firstNonEmpty(env.LOG_LEVEL);
  let logLevel: "debug" | "info" | "warn" | "error" = "info";
  if (!levelSrc) {
    warn(
      '[env] WARN LOG_LEVEL is unset, falling back to "info". ' +
        "Set it explicitly (see .env.example).",
    );
  } else {
    const levelParsed = logLevelSchema.safeParse(levelSrc.toLowerCase());
    if (!levelParsed.success) {
      warn(
        `[env] WARN LOG_LEVEL=${JSON.stringify(levelSrc)} is unknown, falling back to "info". ` +
          "Expected one of debug|info|warn|error (see .env.example).",
      );
    } else {
      logLevel = levelParsed.data;
    }
  }

  // --- github app (optional; empty pair → repos endpoint answers 401) -----
  // Multi-tenant: APP_ID + PRIVATE_KEY are global; the installation id is
  // resolved PER USER from stored installations (install callback / webhook).
  // GITHUB_APP_INSTALLATION_ID stays as a legacy dev fallback (single
  // install, used when the request carries no user installation).
  // Scopes live on the GitHub App itself (metadata:read + contents:read);
  // the backend only mints installation tokens via
  // POST /app/installations/{installation_id}/access_tokens and lists
  // GET /installation/repositories. Private key / tokens never leave env/memory.
  const githubAppId = firstNonEmpty(env.GITHUB_APP_ID);
  const githubPrivateKeyRaw = firstNonEmpty(env.GITHUB_APP_PRIVATE_KEY);
  const githubPrivateKeyPath = firstNonEmpty(env.GITHUB_APP_PRIVATE_KEY_PATH);
  const hasPrivateKey = Boolean(githubPrivateKeyRaw || githubPrivateKeyPath);
  const githubPair = [githubAppId, hasPrivateKey ? "x" : ""].filter(Boolean);
  if (githubPair.length > 0 && githubPair.length < 2) {
    const missing = [
      githubAppId ? null : "GITHUB_APP_ID",
      hasPrivateKey
        ? null
        : "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH",
    ].filter(Boolean) as string[];
    // Names only — values (ids/keys) are never echoed.
    throw new Error(
      `[env] GITHUB_APP_* is partially configured (missing: ${missing.join(", ")}). ` +
        "Set both or none (see .env.example).",
    );
  }
  if (githubAppId && !/^\d+$/.test(githubAppId)) {
    throw new Error(
      "[env] GITHUB_APP_ID must be a numeric app id. Check your .env (see .env.example).",
    );
  }
  if (!githubAppId && !hasPrivateKey) {
    warn(
      "[env] WARN GITHUB_APP_* is not configured — github endpoints answer 401/503. " +
        "Set APP_ID + PRIVATE_KEY (+ SLUG + WEBHOOK_SECRET for the full flow) to enable " +
        "(see .env.example).",
    );
  }
  // Legacy single-install fallback (optional, dev only).
  const githubInstallationId = firstNonEmpty(env.GITHUB_APP_INSTALLATION_ID);
  if (githubInstallationId && !/^\d+$/.test(githubInstallationId)) {
    throw new Error(
      "[env] GITHUB_APP_INSTALLATION_ID must be a numeric installation id. Check your .env (see .env.example).",
    );
  }
  if (githubInstallationId) {
    warn(
      "[env] WARN GITHUB_APP_INSTALLATION_ID is deprecated (legacy single-install dev fallback) — " +
        "prefer per-user installations via the install flow (see .env.example).",
    );
  }
  const githubAppSlug = firstNonEmpty(env.GITHUB_APP_SLUG);
  if (githubAppSlug && !/^[a-z0-9-]+$/i.test(githubAppSlug)) {
    throw new Error(
      "[env] GITHUB_APP_SLUG must be a URL-safe app slug. Check your .env (see .env.example).",
    );
  }
  const githubWebhookSecret = firstNonEmpty(env.GITHUB_WEBHOOK_SECRET);
  const githubApiRaw =
    // readonly-исключение: дефолт публичного GitHub REST — read-конфиг (GHE
    // перекрывается через GITHUB_API_URL; set-but-invalid → ERROR в assertValidUrl).
    firstNonEmpty(env.GITHUB_API_URL) || DEFAULT_GITHUB_API_URL;
  const githubApiUrl = assertValidUrl(githubApiRaw, "GITHUB_API_URL");

  // --- docker registry (optional; unset → skipped, never fail-fast) --------
  // Docker Registry HTTP API v2 (GET /v2/ ping + GET /v2/_catalog).
  // Auth: DOCKER_REGISTRY_TOKEN (Bearer) wins over the basic
  // DOCKER_REGISTRY_USER/PASSWORD pair when both are set. A half-set pair
  // (user without password or vice versa) is a WARN + anonymous access —
  // the registry stays optional, so boot never stops for it. Values are
  // never echoed in errors/logs (names only + .env.example pointer).
  const dockerRegistryRaw = firstNonEmpty(env.DOCKER_REGISTRY_URL);
  let dockerRegistryUrl = "";
  if (dockerRegistryRaw) {
    dockerRegistryUrl = assertValidUrl(
      dockerRegistryRaw,
      "DOCKER_REGISTRY_URL",
    );
  } else {
    warn(
      "[env] WARN DOCKER_REGISTRY_URL is not configured — registry endpoints answer 503 " +
        'and the health flag is "skipped" (see .env.example).',
    );
  }
  const dockerRegistryUser = firstNonEmpty(env.DOCKER_REGISTRY_USER);
  const dockerRegistryPassword = firstNonEmpty(env.DOCKER_REGISTRY_PASSWORD);
  const dockerRegistryToken = firstNonEmpty(env.DOCKER_REGISTRY_TOKEN);
  if (dockerRegistryRaw) {
    if (dockerRegistryToken && (dockerRegistryUser || dockerRegistryPassword)) {
      warn(
        "[env] WARN DOCKER_REGISTRY_TOKEN is set — the basic " +
          "DOCKER_REGISTRY_USER/PASSWORD pair is ignored (see .env.example).",
      );
    } else if (
      !dockerRegistryToken &&
      Boolean(dockerRegistryUser) !== Boolean(dockerRegistryPassword)
    ) {
      const missing = dockerRegistryUser
        ? "DOCKER_REGISTRY_PASSWORD"
        : "DOCKER_REGISTRY_USER";
      warn(
        `[env] WARN DOCKER_REGISTRY_* auth is partially configured (missing: ${missing}) — ` +
          "continuing with anonymous access (see .env.example).",
      );
    } else if (
      !dockerRegistryToken &&
      !dockerRegistryUser &&
      !dockerRegistryPassword
    ) {
      warn(
        "[env] WARN DOCKER_REGISTRY_* has no credentials — continuing with anonymous " +
          "access (see .env.example).",
      );
    }
  }
  const dockerTimeoutRaw = firstNonEmpty(env.DOCKER_REGISTRY_TIMEOUT_MS);
  let dockerRegistryTimeoutMs = DEFAULT_DOCKER_REGISTRY_TIMEOUT_MS;
  if (dockerTimeoutRaw) {
    const parsed = timeoutSchema.safeParse(dockerTimeoutRaw);
    if (!parsed.success) {
      throw new Error(
        `[env] DOCKER_REGISTRY_TIMEOUT_MS must be a non-negative integer ms, got ${JSON.stringify(dockerTimeoutRaw)}. ` +
          "Check your .env (see .env.example).",
      );
    }
    dockerRegistryTimeoutMs = parsed.data;
  } else {
    warn(
      "[env] WARN DOCKER_REGISTRY_TIMEOUT_MS is unset, falling back to " +
        `${DEFAULT_DOCKER_REGISTRY_TIMEOUT_MS} (see .env.example).`,
    );
  }
  const dockerRetryMaxRaw = firstNonEmpty(
    env.DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS,
  );
  const dockerRegistryRetryMaxAttempts = dockerRetryMaxRaw
    ? retryInt(
        dockerRetryMaxRaw,
        "DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS",
        "",
        1,
        10,
      )
    : DEFAULT_DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS;
  if (!dockerRetryMaxRaw) {
    warn(
      "[env] WARN DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS is unset, falling back to " +
        `${DEFAULT_DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS} (see .env.example).`,
    );
  }
  const dockerRetryBaseRaw = firstNonEmpty(
    env.DOCKER_REGISTRY_RETRY_BASE_DELAY_MS,
  );
  const dockerRegistryRetryBaseDelayMs = dockerRetryBaseRaw
    ? retryInt(
        dockerRetryBaseRaw,
        "DOCKER_REGISTRY_RETRY_BASE_DELAY_MS",
        " ms",
        0,
        60000,
      )
    : DEFAULT_DOCKER_REGISTRY_RETRY_BASE_DELAY_MS;
  if (!dockerRetryBaseRaw) {
    warn(
      "[env] WARN DOCKER_REGISTRY_RETRY_BASE_DELAY_MS is unset, falling back to " +
        `${DEFAULT_DOCKER_REGISTRY_RETRY_BASE_DELAY_MS} (see .env.example).`,
    );
  }
  const dockerRetryMaxDelayRaw = firstNonEmpty(
    env.DOCKER_REGISTRY_RETRY_MAX_DELAY_MS,
  );
  const dockerRegistryRetryMaxDelayMs = dockerRetryMaxDelayRaw
    ? retryInt(
        dockerRetryMaxDelayRaw,
        "DOCKER_REGISTRY_RETRY_MAX_DELAY_MS",
        " ms",
        0,
        60000,
      )
    : DEFAULT_DOCKER_REGISTRY_RETRY_MAX_DELAY_MS;
  if (!dockerRetryMaxDelayRaw) {
    warn(
      "[env] WARN DOCKER_REGISTRY_RETRY_MAX_DELAY_MS is unset, falling back to " +
        `${DEFAULT_DOCKER_REGISTRY_RETRY_MAX_DELAY_MS} (see .env.example).`,
    );
  }
  if (dockerRegistryRetryMaxDelayMs < dockerRegistryRetryBaseDelayMs) {
    warn(
      "[env] WARN DOCKER_REGISTRY_RETRY_MAX_DELAY_MS is below DOCKER_REGISTRY_RETRY_BASE_DELAY_MS — " +
        "the backoff ceiling clamps to the base (see .env.example).",
    );
  }

  // --- npm registry (Verdaccio, optional observe-only; unset → skipped) -----
  // Read-only availability probe (GET /-/ping + status endpoint) — the module
  // never publishes/installs, so the bun-install NPM_TOKEN wiring (.npmrc /
  // bunfig [install.scopes]) is untouched. Auth priority: NPM_REGISTRY_TOKEN
  // (Bearer) wins; else the NPM_REGISTRY_USER/PASSWORD basic pair; else
  // anonymous. Legacy NPM_TOKEN is the Bearer fallback when NPM_REGISTRY_TOKEN
  // is unset. Set-but-invalid URL is ERROR (fail-fast like DOCKER_REGISTRY_URL);
  // empty URL → WARN + skipped. A half-set basic pair (user without password or
  // vice versa) is a WARN + anonymous access — the registry stays optional, so
  // boot never stops for it. Values are never echoed in errors/logs
  // (names only + .env.example pointer).
  const npmRegistryRaw = firstNonEmpty(env.NPM_REGISTRY_URL);
  let npmRegistryUrl = "";
  if (npmRegistryRaw) {
    npmRegistryUrl = assertValidUrl(npmRegistryRaw, "NPM_REGISTRY_URL");
  } else {
    warn(
      "[env] WARN NPM_REGISTRY_URL is not configured — npm status endpoint answers 503 " +
        'and the health flag is "skipped" (see .env.example).',
    );
  }
  const npmRegistryTokenExplicit = firstNonEmpty(env.NPM_REGISTRY_TOKEN);
  const npmLegacyToken = firstNonEmpty(env.NPM_TOKEN);
  const npmRegistryToken = npmRegistryTokenExplicit || npmLegacyToken;
  const npmRegistryUser = firstNonEmpty(env.NPM_REGISTRY_USER);
  const npmRegistryPassword = firstNonEmpty(env.NPM_REGISTRY_PASSWORD);
  if (npmRegistryRaw) {
    if (npmRegistryTokenExplicit && npmLegacyToken) {
      warn(
        "[env] WARN NPM_REGISTRY_TOKEN is set — legacy NPM_TOKEN stays for bun install " +
          "only and is ignored by the module (see .env.example).",
      );
    } else if (!npmRegistryTokenExplicit && npmLegacyToken) {
      warn(
        "[env] WARN NPM_REGISTRY_TOKEN is unset, falling back to legacy NPM_TOKEN " +
          "for the module probe (see .env.example).",
      );
    }
    if (npmRegistryToken) {
      if (npmRegistryUser || npmRegistryPassword) {
        warn(
          "[env] WARN NPM_REGISTRY_TOKEN is set — the basic " +
            "NPM_REGISTRY_USER/PASSWORD pair is ignored (see .env.example).",
        );
      }
    } else if (Boolean(npmRegistryUser) !== Boolean(npmRegistryPassword)) {
      const missing = npmRegistryUser
        ? "NPM_REGISTRY_PASSWORD"
        : "NPM_REGISTRY_USER";
      warn(
        `[env] WARN NPM_REGISTRY_* auth is partially configured (missing: ${missing}) — ` +
          "continuing with anonymous access (see .env.example).",
      );
    } else if (!npmRegistryUser && !npmRegistryPassword) {
      warn(
        "[env] WARN NPM_REGISTRY_* has no credentials — continuing with anonymous " +
          "access (see .env.example).",
      );
    }
    // else: complete basic pair, no warning (valid Basic mode).
  }
  const npmScopeRaw = firstNonEmpty(env.NPM_REGISTRY_SCOPE);
  // readonly-исключение: дефолт npm scope — read-конфиг observe-only пробы
  // (не путь записи: модуль никогда не публикует/не ставит пакеты).
  let npmRegistryScope = DEFAULT_NPM_REGISTRY_SCOPE;
  if (npmScopeRaw) {
    if (/^@[a-z0-9-~][a-z0-9-._~]*$/.test(npmScopeRaw)) {
      npmRegistryScope = npmScopeRaw;
    } else {
      warn(
        "[env] WARN NPM_REGISTRY_SCOPE is not a valid npm scope, falling back to " +
          `"${DEFAULT_NPM_REGISTRY_SCOPE}" (see .env.example).`,
      );
    }
  }
  const npmTimeoutRaw = firstNonEmpty(env.NPM_REGISTRY_TIMEOUT_MS);
  let npmRegistryTimeoutMs = DEFAULT_NPM_REGISTRY_TIMEOUT_MS;
  if (npmTimeoutRaw) {
    const parsed = timeoutSchema.safeParse(npmTimeoutRaw);
    if (!parsed.success) {
      throw new Error(
        `[env] NPM_REGISTRY_TIMEOUT_MS must be a non-negative integer ms, got ${JSON.stringify(npmTimeoutRaw)}. ` +
          "Check your .env (see .env.example).",
      );
    }
    npmRegistryTimeoutMs = parsed.data;
  } else {
    warn(
      "[env] WARN NPM_REGISTRY_TIMEOUT_MS is unset, falling back to " +
        `${DEFAULT_NPM_REGISTRY_TIMEOUT_MS} (see .env.example).`,
    );
  }
  const npmRetryMaxRaw = firstNonEmpty(env.NPM_REGISTRY_RETRY_MAX_ATTEMPTS);
  const npmRegistryRetryMaxAttempts = npmRetryMaxRaw
    ? retryInt(npmRetryMaxRaw, "NPM_REGISTRY_RETRY_MAX_ATTEMPTS", "", 1, 10)
    : DEFAULT_NPM_REGISTRY_RETRY_MAX_ATTEMPTS;
  if (!npmRetryMaxRaw) {
    warn(
      "[env] WARN NPM_REGISTRY_RETRY_MAX_ATTEMPTS is unset, falling back to " +
        `${DEFAULT_NPM_REGISTRY_RETRY_MAX_ATTEMPTS} (see .env.example).`,
    );
  }
  const npmRetryBaseRaw = firstNonEmpty(env.NPM_REGISTRY_RETRY_BASE_DELAY_MS);
  const npmRegistryRetryBaseDelayMs = npmRetryBaseRaw
    ? retryInt(
        npmRetryBaseRaw,
        "NPM_REGISTRY_RETRY_BASE_DELAY_MS",
        " ms",
        0,
        60000,
      )
    : DEFAULT_NPM_REGISTRY_RETRY_BASE_DELAY_MS;
  if (!npmRetryBaseRaw) {
    warn(
      "[env] WARN NPM_REGISTRY_RETRY_BASE_DELAY_MS is unset, falling back to " +
        `${DEFAULT_NPM_REGISTRY_RETRY_BASE_DELAY_MS} (see .env.example).`,
    );
  }
  const npmRetryMaxDelayRaw = firstNonEmpty(
    env.NPM_REGISTRY_RETRY_MAX_DELAY_MS,
  );
  const npmRegistryRetryMaxDelayMs = npmRetryMaxDelayRaw
    ? retryInt(
        npmRetryMaxDelayRaw,
        "NPM_REGISTRY_RETRY_MAX_DELAY_MS",
        " ms",
        0,
        60000,
      )
    : DEFAULT_NPM_REGISTRY_RETRY_MAX_DELAY_MS;
  if (!npmRetryMaxDelayRaw) {
    warn(
      "[env] WARN NPM_REGISTRY_RETRY_MAX_DELAY_MS is unset, falling back to " +
        `${DEFAULT_NPM_REGISTRY_RETRY_MAX_DELAY_MS} (see .env.example).`,
    );
  }
  if (npmRegistryRetryMaxDelayMs < npmRegistryRetryBaseDelayMs) {
    warn(
      "[env] WARN NPM_REGISTRY_RETRY_MAX_DELAY_MS is below NPM_REGISTRY_RETRY_BASE_DELAY_MS — " +
        "the backoff ceiling clamps to the base (see .env.example).",
    );
  }

  // --- projects root + repos root + frontend api url --------------------------
  const projectsRootRaw = firstNonEmpty(env.PROJECTS_ROOT);
  if (projectsRootRaw.includes("\0")) {
    throw new Error(
      "[env] PROJECTS_ROOT must be a valid directory path. Check your .env (see .env.example).",
    );
  }
  const projectsRoot = projectsRootRaw;
  if (projectsRoot && !existsSync(resolvePath(projectsRoot))) {
    warn(
      `[env] WARN PROJECTS_ROOT points to a missing directory: ${JSON.stringify(projectsRoot)}. ` +
        "The file browser will 404 until it exists (see .env.example).",
    );
  }

  // --- repos root (readonly git registry REPOS_ROOT/<user-space>/workspace/<repo>) ---
  const reposRaw = firstNonEmpty(env.REPOS_ROOT);
  if (reposRaw.includes("\0")) {
    throw new Error(
      "[env] REPOS_ROOT must be a valid directory path. Check your .env (see .env.example).",
    );
  }
  let reposRoot: string;
  if (reposRaw) {
    const resolved = resolvePath(reposRaw);
    try {
      accessSync(resolved, fsConstants.R_OK);
    } catch {
      throw new Error(
        `[env] REPOS_ROOT points to an unreadable directory: ${JSON.stringify(reposRaw)}. ` +
          "Create it or fix permissions (see .env.example).",
      );
    }
    try {
      reposRoot = realpathSync(resolved);
    } catch {
      reposRoot = resolved;
    }
  } else {
    // Unified catalog: REPOS_ROOT is the single source for reads AND writes.
    // Empty → unconfigured storage (reposRoot stays ''): boot continues but
    // logs at ERROR level — projects are unavailable (creates answer 500,
    // storage reads deny with 503). Set REPOS_ROOT in .env (see .env.example).
    // No <PROJECTS_ROOT>/repos or <cwd>/repos fallback — never read or create
    // outside the explicit root. Health is unchanged by this branch.
    reposRoot = "";
    warn(
      "[env] ERROR REPOS_ROOT is not configured — project storage is unavailable " +
        "(reads deny with 503, creates answer 500). Set REPOS_ROOT in .env (see .env.example).",
    );
  }
  const nextPublicApiRaw = firstNonEmpty(env.NEXT_PUBLIC_API_URL);
  let nextPublicApiUrl: string;
  if (nextPublicApiRaw && !looksBroken(nextPublicApiRaw)) {
    nextPublicApiUrl = assertValidUrl(nextPublicApiRaw, "NEXT_PUBLIC_API_URL");
  } else {
    if (nextPublicApiRaw && looksBroken(nextPublicApiRaw)) {
      warn(
        "[env] WARN NEXT_PUBLIC_API_URL looks broken (empty host from ${...} interpolation), " +
          "falling back to the backend socket (see .env.example).",
      );
    }
    nextPublicApiUrl = backendSocket; // readonly-исключение: frontend default = same origin as the backend (read-конфиг; явный URL валидируется выше, битый ${...} → WARN + recompose)
  }

  // --- auth (internal accounts: HS256 JWT + legacy mock fallback) --------
  // Secrets only via env, never logged (values never echoed, names only).
  // Unset secret → ephemeral dev secret (random per boot) + WARN — explicit
  // values must be ≥ 32 chars (ERROR otherwise). TTLs accept '15m' | '1h' |
  // '7d' | seconds; garbage is ERROR. AUTH_LEGACY_MOCK_FALLBACK unset → true
  // (dev default) + WARN; explicit 'true'/'1' or 'false'/'0', else ERROR.
  const jwtAccessSecretRaw = firstNonEmpty(env.JWT_ACCESS_SECRET);
  const jwtRefreshSecretRaw = firstNonEmpty(env.JWT_REFRESH_SECRET);
  const checkJwtSecret = (raw: string, name: string): void => {
    if (raw.length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(
        `[env] ${name} must be at least ${MIN_JWT_SECRET_LENGTH} chars (see .env.example).`,
      );
    }
  };
  let jwtAccessSecret: string;
  if (jwtAccessSecretRaw) {
    checkJwtSecret(jwtAccessSecretRaw, "JWT_ACCESS_SECRET");
    jwtAccessSecret = jwtAccessSecretRaw;
  } else {
    warn(
      "[env] WARN JWT_ACCESS_SECRET is unset — using an ephemeral dev secret " +
        "(tokens invalidate on restart). Set it explicitly for production (see .env.example).",
    );
    jwtAccessSecret = ephemeralDevJwtSecret("access");
  }
  let jwtRefreshSecret: string;
  if (jwtRefreshSecretRaw) {
    checkJwtSecret(jwtRefreshSecretRaw, "JWT_REFRESH_SECRET");
    jwtRefreshSecret = jwtRefreshSecretRaw;
  } else {
    warn(
      "[env] WARN JWT_REFRESH_SECRET is unset — using an ephemeral dev secret " +
        "(tokens invalidate on restart). Set it explicitly for production (see .env.example).",
    );
    jwtRefreshSecret = ephemeralDevJwtSecret("refresh");
  }
  const parseJwtTtl = (
    raw: string | undefined,
    name: string,
    fallback: number,
  ): number => {
    // readonly-исключение: JWT TTL-дефолты (15m/7d) — тюнинг времени жизни
    // чтения/валидации токенов; мусор формата → ERROR ниже (60..7776000).
    if (!raw || raw.trim() === "") return fallback;
    const v = raw.trim();
    let sec = NaN;
    if (/^\d+$/.test(v)) {
      sec = Number(v);
    } else {
      const m = /^(\d+)\s*([smhd])$/i.exec(v);
      if (m) {
        const mult = { s: 1, m: 60, h: 3600, d: 86400 }[
          m[2].toLowerCase() as "s" | "m" | "h" | "d"
        ];
        sec = Number(m[1]) * mult;
      }
    }
    if (!Number.isInteger(sec) || sec < 60 || sec > 90 * 86400) {
      throw new Error(
        `[env] ${name} must be a TTL like 15m/1h/7d or seconds 60-7776000, got ${JSON.stringify(raw)}. ` +
          "Check your .env (see .env.example).",
      );
    }
    return sec;
  };
  const jwtAccessTtlSec = parseJwtTtl(
    firstNonEmpty(env.JWT_ACCESS_TTL) || undefined,
    "JWT_ACCESS_TTL",
    DEFAULT_JWT_ACCESS_TTL_SEC,
  );
  const jwtRefreshTtlSec = parseJwtTtl(
    firstNonEmpty(env.JWT_REFRESH_TTL) || undefined,
    "JWT_REFRESH_TTL",
    DEFAULT_JWT_REFRESH_TTL_SEC,
  );
  const legacyFallbackRaw = firstNonEmpty(env.AUTH_LEGACY_MOCK_FALLBACK);
  let authLegacyMockFallback: boolean;
  if (!legacyFallbackRaw) {
    authLegacyMockFallback = true;
    warn(
      '[env] WARN AUTH_LEGACY_MOCK_FALLBACK is unset, falling back to "true" (dev default: ' +
        'x-user-id mock identity still accepted). Set "false" for production (see .env.example).',
    );
  } else if (/^(true|1)$/i.test(legacyFallbackRaw)) {
    authLegacyMockFallback = true;
  } else if (/^(false|0)$/i.test(legacyFallbackRaw)) {
    authLegacyMockFallback = false;
  } else {
    throw new Error(
      `[env] AUTH_LEGACY_MOCK_FALLBACK must be "true" or "false", got ${JSON.stringify(legacyFallbackRaw)}. ` +
        "Check your .env (see .env.example).",
    );
  }

  // --- organizations: single-use invite TTL (read-tuning for token expiry;
  // garbage is ERROR, unset is the 24h dev default + WARN) ------------------
  const orgInviteTtlRaw = firstNonEmpty(env.ORG_INVITE_TTL_SEC);
  let orgInviteTtlSec = DEFAULT_ORG_INVITE_TTL_SEC;
  if (orgInviteTtlRaw) {
    const parsed = timeoutSchema.safeParse(orgInviteTtlRaw);
    if (
      !parsed.success ||
      !Number.isInteger(parsed.data) ||
      parsed.data < 60 ||
      parsed.data > 90 * 86400
    ) {
      throw new Error(
        `[env] ORG_INVITE_TTL_SEC must be seconds 60-7776000, got ${JSON.stringify(orgInviteTtlRaw)}. ` +
          "Check your .env (see .env.example).",
      );
    }
    orgInviteTtlSec = parsed.data;
  } else {
    warn(
      "[env] WARN ORG_INVITE_TTL_SEC is unset, falling back to " +
        `${DEFAULT_ORG_INVITE_TTL_SEC} (24h). Set it explicitly (see .env.example).`,
    );
  }

  // --- unknown keys (likely typos) ---------------------------------------------
  const unknownKeys = findSuspiciousUnknownKeys(source);
  if (unknownKeys.length > 0) {
    warn(
      `[env] WARN unknown env key(s) resembling app config: ${unknownKeys.join(", ")}. ` +
        "Check spelling (see .env.example).",
    );
  }

  return {
    env: {
      backendPort,
      backendHost,
      backendProtocol,
      backendSocket,
      opencodeUrl,
      opencodeToken,
      opencodeKeysEncryptionKey,
      opencodeKeysEncryptionKeyPrevious,
      opencodeKeysActiveKeyId,
      opencodeKeysPreviousKeyId,
      databaseUrl,
      corsOrigins,
      requestTimeoutMs,
      externalRetryMaxAttempts,
      externalRetryBaseDelayMs,
      externalRetryMaxDelayMs,
      logLevel,
      nextPublicPort,
      githubAppId,
      githubPrivateKey: resolveGithubPrivateKey(
        githubPrivateKeyRaw,
        githubPrivateKeyPath,
      ),
      githubPrivateKeyPath,
      githubInstallationId,
      githubAppSlug,
      githubWebhookSecret,
      githubApiUrl,
      projectsRoot,
      reposRoot,
      nextPublicApiUrl,
      dockerRegistryUrl,
      dockerRegistryUser,
      dockerRegistryPassword,
      dockerRegistryToken,
      dockerRegistryTimeoutMs,
      dockerRegistryRetryMaxAttempts,
      dockerRegistryRetryBaseDelayMs,
      dockerRegistryRetryMaxDelayMs,
      npmRegistryUrl,
      npmRegistryToken,
      npmRegistryUser,
      npmRegistryPassword,
      npmRegistryScope,
      npmRegistryTimeoutMs,
      npmRegistryRetryMaxAttempts,
      npmRegistryRetryBaseDelayMs,
      npmRegistryRetryMaxDelayMs,
      jwtAccessSecret,
      jwtRefreshSecret,
      jwtAccessTtlSec,
      jwtRefreshTtlSec,
      authLegacyMockFallback,
      orgInviteTtlSec,
    },
    warnings,
  };
}

/**
 * Fail-fast typed env access. Pure (collects warnings without logging) so
 * per-request callers stay quiet — use validateEnvWithWarnings() at boot and
 * log the warnings once via AppLogger (see main.ts).
 */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return validateEnvWithWarnings(source).env;
}

/**
 * ConfigModule.forRoot({ validate }) entry — fail-fast without logging secrets.
 * Returns the raw config untouched after structural validation; typed access
 * goes through validateEnv() / ConfigService + helpers above.
 */
export function validateConfigForNest(
  config: Record<string, unknown>,
): Record<string, unknown> {
  validateEnv(config as NodeJS.ProcessEnv);
  return config;
}
