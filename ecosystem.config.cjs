// PM2 dev ecosystem — local development only (never commit .env).
// Usage: cp .env.example .env && bun install && bun run dev
// Teardown: bun run dev:shutdown
// Aliases (kept for compatibility): bun run dev:pm2 / dev:logs / dev:pm2:logs /
//   dev:restart / dev:pm2:restart / dev:pm2:stop
// Runtime: Bun (>=1.4.2, see .bun-version) is the primary runtime — PM2 spawns
// `bun run …` per app. Node >=22 remains a fallback until CI is green on Bun
// (see README "Node fallback"): replace `bun` with `npm` in `script`/`args`
// below and run `npm install` / `npm run dev` instead.
//
// How .env is picked up:
// - This file parses the repo-root .env (no extra deps, plain Node), expands
//   ${VAR} / ${VAR:-default} (same syntax as dotenv-expand / docker-compose),
//   and injects values into each app's `env`. PM2 puts `env` into process.env
//   before spawn, so backend `dotenv-expand` (does not override existing env)
//   and Next.js `NEXT_PUBLIC_*` (read from process.env at dev time, inlined
//   at `next build` time) both work.
// - Relying on PM2 `env_file` is avoided: support varies across versions.
// - If root .env is missing, safe dev defaults (mirroring .env.example,
//   DATABASE_URL composed from POSTGRES_* defaults) are used.
//   Existing shell env always wins over file/defaults (process.env > file > DEFAULTS).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DOTENV_PATH = path.join(ROOT, '.env');

/** Minimal .env parser (KEY=VALUE, # comments, optional quotes). No deps. */
function parseDotEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip inline ` # comment` only when preceded by whitespace and value unquoted.
    const isQuoted =
      (value.startsWith('"') && value.includes('"', 1)) ||
      (value.startsWith("'") && value.includes("'", 1)) ||
      value.startsWith('`');
    if (!isQuoted) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('`') && value.endsWith('`'))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** Expand ${VAR} and ${VAR:-default} without external deps.
 * - Lookup order per reference: process.env > fileEnv (raw) > defaults.
 * - Iterates up to MAX_PASSES for nested refs; cycle/unclosed templates left as-is.
 */
function expandValue(value, fileEnv, defaults, seen) {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
  let out = value;
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    out = out.replace(pattern, (match, name, def) => {
      if (seen.has(name)) return match; // cycle guard: leave template as-is
      let resolved;
      if (process.env[name] !== undefined && process.env[name] !== '') {
        resolved = process.env[name];
      } else if (fileEnv[name] !== undefined && fileEnv[name] !== '') {
        resolved = fileEnv[name];
      } else if (defaults[name] !== undefined) {
        resolved = defaults[name];
      } else if (def !== undefined) {
        resolved = def;
      } else {
        return match; // unknown var without default: leave as-is
      }
      // Resolve nested templates in the referenced value (cycle-tracked).
      seen.add(name);
      const nested = expandValue(String(resolved), fileEnv, defaults, seen);
      seen.delete(name);
      if (nested !== match) changed = true;
      // Referenced value itself may still contain an unresolvable template;
      // substitute it verbatim (no infinite loop — outer passes converge).
      return nested;
    });
    if (!changed) break;
  }
  return out;
}

/** Expand every key of a parsed .env map. Unclosed `${` left untouched. */
function expandDotEnvFile(fileEnv, defaults) {
  const out = {};
  for (const key of Object.keys(fileEnv)) {
    out[key] = expandValue(fileEnv[key], fileEnv, defaults, new Set([key]));
  }
  return out;
}

// Dev-safe defaults mirroring .env.example (no secrets).
// POSTGRES_* are the single source; composite keys resolve via expand/fallback.
// Empty HOSTs fall back to localhost here so ${PROTO}://${HOST}:${PORT}
// interpolation never yields `http://:` when .env leaves HOST empty.
const DEFAULTS = {
  POSTGRES_USER: 'devbox',
  POSTGRES_PASSWORD: 'changeme',
  POSTGRES_DB: 'devbox',
  POSTGRES_PORT: '5432',
  POSTGRES_HOST: 'localhost',
  APP_BACKEND_PORT: '3100',
  APP_BACKEND_HOST: 'localhost',
  APP_BACKEND_PROTOCOL: 'http',
  OPENCODE_PORT: '4096',
  OPENCODE_HOST: 'localhost',
  OPENCODE_PROTOCOL: 'http',
  CORS_ORIGINS: 'http://localhost:${NEXT_PUBLIC_PORT},http://localhost:8080',
  REQUEST_TIMEOUT_MS: '10000',
  LOG_LEVEL: 'info',
  NEXT_PUBLIC_PORT: '3001',
};

const rawFileEnv = parseDotEnvFile(DOTENV_PATH);
const fileEnv = expandDotEnvFile(rawFileEnv, DEFAULTS);

function pick(key, fallback) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  if (fileEnv[key] !== undefined && fileEnv[key] !== '') return fileEnv[key];
  return fallback;
}

// Shared env injected into every pm2 app (strings only — pm2 requirement).
// New names first, legacy fallbacks after (old shell .env with PORT /
// OPENCODE_SERVER_URL keeps working: process.env > file > DEFAULTS).
// Composite SOCKET/URL/CORS/API_URL resolve via interpolation when set in
// .env, otherwise composed here from parts (never `http://:`).
function firstOf(keys, fallback) {
  for (const k of keys) {
    const v = pick(k, '');
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return fallback;
}
const backendPort = firstOf(['APP_BACKEND_PORT', 'PORT'], DEFAULTS.APP_BACKEND_PORT);
const backendHost = firstOf(['APP_BACKEND_HOST'], DEFAULTS.APP_BACKEND_HOST);
const backendProto = firstOf(['APP_BACKEND_PROTOCOL'], DEFAULTS.APP_BACKEND_PROTOCOL);
const backendSocket = firstOf(
  ['APP_BACKEND_SOCKET'],
  `${backendProto}://${backendHost}:${backendPort}`,
);
const opencodeUrl = firstOf(
  ['OPENCODE_URL', 'OPENCODE_SERVER_URL'],
  `${firstOf(['OPENCODE_PROTOCOL'], DEFAULTS.OPENCODE_PROTOCOL)}://${firstOf(['OPENCODE_HOST'], DEFAULTS.OPENCODE_HOST)}:${firstOf(['OPENCODE_PORT'], DEFAULTS.OPENCODE_PORT)}`,
);
const nextPublicPort = firstOf(['NEXT_PUBLIC_PORT'], DEFAULTS.NEXT_PUBLIC_PORT);
const sharedEnv = {
  APP_BACKEND_PORT: backendPort,
  PORT: backendPort, // legacy alias — old tooling reading PORT keeps working
  APP_BACKEND_HOST: backendHost,
  APP_BACKEND_PROTOCOL: backendProto,
  APP_BACKEND_SOCKET: backendSocket,
  OPENCODE_URL: opencodeUrl,
  OPENCODE_SERVER_URL: opencodeUrl, // legacy alias
  OPENCODE_HOST: firstOf(['OPENCODE_HOST'], DEFAULTS.OPENCODE_HOST),
  OPENCODE_PORT: firstOf(['OPENCODE_PORT'], DEFAULTS.OPENCODE_PORT),
  OPENCODE_PROTOCOL: firstOf(['OPENCODE_PROTOCOL'], DEFAULTS.OPENCODE_PROTOCOL),
  CORS_ORIGINS: String(
    pick('CORS_ORIGINS', `http://localhost:${nextPublicPort},http://localhost:8080`),
  ),
  REQUEST_TIMEOUT_MS: String(pick('REQUEST_TIMEOUT_MS', DEFAULTS.REQUEST_TIMEOUT_MS)),
  LOG_LEVEL: String(pick('LOG_LEVEL', DEFAULTS.LOG_LEVEL)),
  NEXT_PUBLIC_API_URL: String(pick('NEXT_PUBLIC_API_URL', backendSocket)),
  NEXT_PUBLIC_PORT: nextPublicPort,
};
// DATABASE_URL: expanded value wins; when still empty, compose from POSTGRES_*
// (same precedence: shell > file > DEFAULTS) so interpolated .env always resolves.
function buildDatabaseUrlFallback() {
  const pickOr = (k, fb) => {
    const v = pick(k, fb);
    return v === undefined || v === null ? '' : String(v);
  };
  const user = pickOr('POSTGRES_USER', DEFAULTS.POSTGRES_USER);
  const pass = pickOr('POSTGRES_PASSWORD', DEFAULTS.POSTGRES_PASSWORD);
  const host = pickOr('POSTGRES_HOST', DEFAULTS.POSTGRES_HOST);
  const port = pickOr('POSTGRES_PORT', DEFAULTS.POSTGRES_PORT);
  const db = pickOr('POSTGRES_DB', DEFAULTS.POSTGRES_DB);
  if (!user || !db) return '';
  return `postgres://${user}:${pass}@${host}:${port}/${db}`;
}
const databaseUrl = pick('DATABASE_URL', '');
if (databaseUrl) sharedEnv.DATABASE_URL = String(databaseUrl);
else {
  const fallback = buildDatabaseUrlFallback();
  if (fallback) sharedEnv.DATABASE_URL = fallback;
}
// Postgres vars are only needed for docker-compose, but pass through when set.
for (const k of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_PORT', 'POSTGRES_HOST']) {
  const v = pick(k, '');
  if (v) sharedEnv[k] = String(v);
}
// GitHub App (multi-tenant install flow): forward GITHUB_* from the root .env
// (shell > file) so pm2-spawned apps see the same values as `bun run dev`.
// Without this, GET /api/v1/projects/github/install-url answers 503
// ("GitHub App install is not configured") rendered as an internal_error
// envelope by ApiErrorFilter. Only non-empty values are forwarded.
for (const k of [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_API_URL',
]) {
  const v = pick(k, '');
  if (v) sharedEnv[k] = String(v);
}

// Docker Registry (private registry proxy): forward DOCKER_REGISTRY_* from root .env
// (shell > file) so pm2-spawned backend (cwd apps/backend) sees the same values
// as `bun run dev`. Without this, validateEnv gets empty → WARN skipped.
// Only non-empty values are forwarded (same scheme as GITHUB_* above).
for (const k of [
  'DOCKER_REGISTRY_URL',
  'DOCKER_REGISTRY_USER',
  'DOCKER_REGISTRY_PASSWORD',
  'DOCKER_REGISTRY_TOKEN',
  'DOCKER_REGISTRY_TIMEOUT_MS',
  'DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS',
  'DOCKER_REGISTRY_RETRY_BASE_DELAY_MS',
  'DOCKER_REGISTRY_RETRY_MAX_DELAY_MS',
  'REPOS_ROOT',
  'PROJECTS_ROOT',
]) {
  const v = pick(k, '');
  if (v) sharedEnv[k] = String(v);
}

// NPM Registry (Verdaccio proxy): forward NPM_REGISTRY_* from root .env
// (shell > file) so pm2-spawned backend sees the same values as `bun run dev`.
// Without this, backend under pm2 sees empty NPM_REGISTRY_URL → skipped →
// GET /api/v1/registry/npm/status answers 503 with no per-request log.
// Only non-empty values are forwarded (same scheme as GITHUB_*/DOCKER_* above).
// Secret values are never logged — only passed through to process.env.
for (const k of [
  'NPM_REGISTRY_URL',
  'NPM_REGISTRY_TOKEN',
  'NPM_TOKEN',
  'NPM_REGISTRY_USER',
  'NPM_REGISTRY_PASSWORD',
  'NPM_REGISTRY_SCOPE',
  'NPM_REGISTRY_TIMEOUT_MS',
  'NPM_REGISTRY_RETRY_MAX_ATTEMPTS',
  'NPM_REGISTRY_RETRY_BASE_DELAY_MS',
  'NPM_REGISTRY_RETRY_MAX_DELAY_MS',
]) {
  const v = pick(k, '');
  if (v) sharedEnv[k] = String(v);
}

module.exports = {
  apps: [
    {
      name: 'devbox-backend',
      cwd: './apps/backend',
      script: 'bun',
      args: 'run dev',
      instances: 1,
      exec_mode: 'fork',
      watch: ['src'],
      ignore_watch: ['node_modules', 'dist'],
      autorestart: true,
      env: { ...sharedEnv },
    },
    {
      name: 'devbox-frontend',
      cwd: './apps/frontend',
      script: 'bun',
      args: 'run dev:next',
      instances: 1,
      exec_mode: 'fork',
      watch: ['app', 'src', 'next.config.mjs'],
      ignore_watch: ['node_modules', '.next', 'dist'],
      autorestart: true,
      env: { ...sharedEnv },
    },
  ],
};
