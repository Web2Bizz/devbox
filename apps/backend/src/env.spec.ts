/**
 * env validation unit checks — self-contained runner (no new deps, plain node:assert).
 *
 * Covers docs/env-validation.md: zod@4 schemas, ERROR fail-fast vs WARN continue,
 * `[env]` message format, and the never-log-secrets rule.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/env.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  corsOriginsSchema,
  databaseUrlSchema,
  findSuspiciousUnknownKeys,
  urlSchema,
  validateEnv,
  validateEnvWithWarnings,
} from './env.js';

type Source = NodeJS.ProcessEnv;

/** Fully explicit source — no fallback/deprecated/unknown WARNs expected. */
function baseEnv(): Source {
  return {
    APP_BACKEND_PORT: '3000',
    APP_BACKEND_HOST: '127.0.0.1',
    APP_BACKEND_PROTOCOL: 'http',
    OPENCODE_URL: 'http://127.0.0.1:4096',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    CORS_ORIGINS: 'http://localhost:3001',
    REQUEST_TIMEOUT_MS: '10000',
    LOG_LEVEL: 'info',
    NEXT_PUBLIC_PORT: '3001',
    NEXT_PUBLIC_API_URL: 'http://localhost:3000',
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: 'test-key-not-real-never-logged',
    GITHUB_API_URL: 'https://api.github.com',
    REPOS_ROOT: tmpdir(),
    DOCKER_REGISTRY_URL: 'http://127.0.0.1:5000',
    DOCKER_REGISTRY_TOKEN: 'test-token-not-real-never-logged',
    DOCKER_REGISTRY_TIMEOUT_MS: '10000',
    DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS: '3',
    DOCKER_REGISTRY_RETRY_BASE_DELAY_MS: '200',
    DOCKER_REGISTRY_RETRY_MAX_DELAY_MS: '2000',
    NPM_REGISTRY_URL: 'https://npm.registry.web2bizz.team',
    NPM_REGISTRY_TOKEN: 'test-npm-token-not-real-never-logged',
    NPM_REGISTRY_SCOPE: '@web2bizz',
    NPM_REGISTRY_TIMEOUT_MS: '10000',
    NPM_REGISTRY_RETRY_MAX_ATTEMPTS: '3',
    NPM_REGISTRY_RETRY_BASE_DELAY_MS: '200',
    NPM_REGISTRY_RETRY_MAX_DELAY_MS: '2000',
    JWT_ACCESS_SECRET: 'test-jwt-access-secret-not-real-0123456789',
    JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-not-real-0123456789',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '7d',
    AUTH_LEGACY_MOCK_FALLBACK: 'false',
    ORG_INVITE_TTL_SEC: '86400',
    OPENCODE_KEYS_ENCRYPTION_KEY: 'test-opencode-keys-encryption-key-not-real-0123456789',
  } as Source;
}

function without(source: Source, ...keys: string[]): Source {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (!keys.includes(k) && typeof v === 'string') out[k] = v;
  }
  return out as Source;
}

function expectThrow(fn: () => unknown, re: RegExp, label: string): string {
  try {
    fn();
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, re, `${label}: ${msg}`);
    return msg;
  }
  assert.fail(`${label}: expected throw`);
}

const checks: Array<{ name: string; run: () => void }> = [
  {
    name: 'valid full env passes with zero warnings',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings(baseEnv());
      assert.equal(env.backendPort, 3000);
      assert.equal(env.backendSocket, 'http://127.0.0.1:3000');
      assert.equal(env.opencodeUrl, 'http://127.0.0.1:4096');
      assert.equal(env.databaseUrl, 'postgres://u:p@localhost:5432/db');
      assert.deepEqual(env.corsOrigins, ['http://localhost:3001']);
      assert.equal(env.logLevel, 'info');
      assert.equal(env.nextPublicPort, 3001);
      assert.equal(env.nextPublicApiUrl, 'http://localhost:3000');
      assert.equal(env.projectsRoot, '');
      assert.equal(env.reposRoot, realpathSync(tmpdir()));
      assert.equal(env.githubAppId, '123456');
      assert.equal(env.dockerRegistryUrl, 'http://127.0.0.1:5000');
      assert.equal(env.dockerRegistryTimeoutMs, 10000);
      assert.equal(env.dockerRegistryRetryMaxAttempts, 3);
      assert.equal(env.npmRegistryUrl, 'https://npm.registry.web2bizz.team');
      assert.equal(env.npmRegistryScope, '@web2bizz');
      assert.equal(env.npmRegistryTimeoutMs, 10000);
      assert.equal(env.npmRegistryRetryMaxAttempts, 3);
      assert.equal(env.jwtAccessSecret, 'test-jwt-access-secret-not-real-0123456789');
      assert.equal(env.jwtRefreshSecret, 'test-jwt-refresh-secret-not-real-0123456789');
      assert.equal(env.jwtAccessTtlSec, 900);
      assert.equal(env.jwtRefreshTtlSec, 604800);
      assert.equal(env.authLegacyMockFallback, false);
      assert.equal(env.orgInviteTtlSec, 86400);
      assert.equal(env.opencodeKeysEncryptionKey, 'test-opencode-keys-encryption-key-not-real-0123456789');
      assert.deepEqual(warnings, []);
    },
  },
  {
    name: 'invalid port is ERROR fail-fast',
    run: () => {
      const msg = expectThrow(
        () => validateEnv({ ...baseEnv(), APP_BACKEND_PORT: 'abc' } as Source),
        /\[env\] APP_BACKEND_PORT/,
        'invalid port',
      );
      assert.ok(msg.includes('.env.example'));
    },
  },
  {
    name: 'broken socket http://: recomposes with WARN (no throw)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...baseEnv(),
        APP_BACKEND_SOCKET: 'http://:',
        APP_BACKEND_HOST: '',
      } as Source);
      assert.equal(env.backendSocket, 'http://localhost:3000');
      assert.ok(
        warnings.some((w) => w.includes('APP_BACKEND_SOCKET') && w.includes('WARN')),
        `expected socket WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'CORS garbage is ERROR with entry index',
    run: () => {
      const msg = expectThrow(
        () => validateEnv({ ...baseEnv(), CORS_ORIGINS: 'not-a-url,http://localhost:3001' } as Source),
        /\[env\] CORS_ORIGINS entry #1/,
        'cors garbage',
      );
      assert.ok(msg.includes('.env.example'));
    },
  },
  {
    name: 'DATABASE_URL bad shape is ERROR without echoing the value',
    run: () => {
      const secretish = 'nonsense-scheme://user:hunter2@example.com/db';
      const msg = expectThrow(
        () => validateEnv({ ...baseEnv(), DATABASE_URL: secretish } as Source),
        /\[env\] DATABASE_URL/,
        'database url shape',
      );
      assert.ok(!msg.includes('nonsense-scheme'), 'secret-bearing value leaked into the error');
      assert.ok(!msg.includes('hunter2'), 'credential leaked into the error');
    },
  },
  {
    name: 'partial GITHUB pair (ID without key) is ERROR',
    run: () => {
      expectThrow(
        () => validateEnv(without(baseEnv(), 'GITHUB_APP_PRIVATE_KEY')),
        /partially configured/,
        'partial github pair',
      );
    },
  },
  {
    name: 'unknown app-prefixed key WARNs, unrelated vars are ignored',
    run: () => {
      const { warnings } = validateEnvWithWarnings({
        ...baseEnv(),
        APP_BACKEND_PORTT: '3000',
        SOME_RANDOM_VAR: '1',
      } as Source);
      assert.ok(
        warnings.some((w) => w.includes('APP_BACKEND_PORTT')),
        `expected typo WARN, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        !warnings.some((w) => w.includes('SOME_RANDOM_VAR')),
        'unrelated vars must stay silent',
      );
      assert.deepEqual(findSuspiciousUnknownKeys({ HOME: '/root', PATH: '/bin' } as Source), []);
    },
  },
  {
    name: 'unknown LOG_LEVEL falls back to info with WARN',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...baseEnv(),
        LOG_LEVEL: 'verbose',
      } as Source);
      assert.equal(env.logLevel, 'info');
      assert.ok(
        warnings.some((w) => w.includes('WARN') && w.includes('LOG_LEVEL')),
        `expected LOG_LEVEL WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'deprecated GITHUB_APP_INSTALLATION_ID WARNs (still accepted when numeric)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...baseEnv(),
        GITHUB_APP_INSTALLATION_ID: '789012',
      } as Source);
      assert.equal(env.githubInstallationId, '789012');
      assert.ok(
        warnings.some((w) => w.includes('deprecated') && w.includes('GITHUB_APP_INSTALLATION_ID')),
        `expected deprecation WARN, got: ${JSON.stringify(warnings)}`,
      );
      expectThrow(
        () =>
          validateEnv({ ...baseEnv(), GITHUB_APP_INSTALLATION_ID: 'not-a-number' } as Source),
        /\[env\] GITHUB_APP_INSTALLATION_ID/,
        'non-numeric installation id stays ERROR',
      );
    },
  },
  {
    name: 'empty GITHUB pair WARNs (endpoints answer 401/503)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings(
        without(baseEnv(), 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'),
      );
      assert.equal(env.githubAppId, '');
      assert.ok(
        warnings.some((w) => w.includes('GITHUB_APP_* is not configured')),
        `expected github WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'invalid NEXT_PUBLIC_API_URL is ERROR',
    run: () => {
      expectThrow(
        () => validateEnv({ ...baseEnv(), NEXT_PUBLIC_API_URL: '::bad::' } as Source),
        /\[env\] NEXT_PUBLIC_API_URL/,
        'next public api url',
      );
    },
  },
  {
    name: 'explicit REPOS_ROOT on a missing dir is ERROR fail-fast',
    run: () => {
      const msg = expectThrow(
        () => validateEnv({ ...baseEnv(), REPOS_ROOT: './definitely-missing-repos-xyz' } as Source),
        /\[env\] REPOS_ROOT/,
        'missing repos root',
      );
      assert.ok(msg.includes('.env.example'));
      expectThrow(
        () => validateEnv({ ...baseEnv(), REPOS_ROOT: 'bad\0path' } as Source),
        /\[env\] REPOS_ROOT/,
        'NUL byte in repos root',
      );
    },
  },
  {
    name: 'unset REPOS_ROOT → unconfigured storage (reposRoot "") + ERROR boot message (no fallback)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...without(baseEnv(), 'REPOS_ROOT'),
        PROJECTS_ROOT: tmpdir(),
      } as Source);
      assert.equal(env.reposRoot, '');
      const boot = warnings.find((w) => w.includes('REPOS_ROOT'));
      assert.ok(boot, `expected REPOS_ROOT boot message, got: ${JSON.stringify(warnings)}`);
      assert.ok(boot.includes('ERROR'), `boot message must be ERROR-level, got: ${boot}`);
      assert.ok(boot.includes('not configured'), `boot message must state outage, got: ${boot}`);
      assert.ok(boot.includes('503'), `boot message must mention read deny (503), got: ${boot}`);
      assert.ok(boot.includes('500'), `boot message must mention create deny (500), got: ${boot}`);
      assert.ok(boot.includes('REPOS_ROOT'), `boot message must name the key, got: ${boot}`);
      assert.ok(boot.includes('.env.example'), `boot message must point at .env.example, got: ${boot}`);
      assert.ok(
        !boot.includes('<cwd>/repos') && !boot.includes('<PROJECTS_ROOT>/repos'),
        `no silent fallback paths in boot message, got: ${boot}`,
      );
    },
  },
  {
    name: 'unset REPOS_ROOT + empty PROJECTS_ROOT → same ERROR deny (unified catalog, no <cwd>/repos)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings(
        without(baseEnv(), 'REPOS_ROOT'),
      );
      assert.equal(env.reposRoot, '');
      const boot = warnings.find((w) => w.includes('REPOS_ROOT'));
      assert.ok(boot && boot.includes('ERROR'), `expected ERROR deny, got: ${JSON.stringify(warnings)}`);
    },
  },
  {
    name: 'missing PROJECTS_ROOT directory WARNs (no throw)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...baseEnv(),
        PROJECTS_ROOT: './definitely-missing-dir-xyz',
      } as Source);
      assert.equal(env.projectsRoot, './definitely-missing-dir-xyz');
      assert.ok(
        warnings.some((w) => w.includes('PROJECTS_ROOT')),
        `expected PROJECTS_ROOT WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'zod schemas accept/reject shapes directly',
    run: () => {
      assert.equal(urlSchema.safeParse('http://localhost:3000').success, true);
      assert.equal(urlSchema.safeParse('http://:3000').success, false);
      assert.equal(databaseUrlSchema.safeParse('postgres://u@h:5432/d').success, true);
      assert.equal(databaseUrlSchema.safeParse('postgresql://u@h:5432/d').success, true);
      assert.equal(databaseUrlSchema.safeParse('http://h:5432/d').success, false);
      assert.deepEqual(corsOriginsSchema.safeParse('http://a:1, https://b:2').data, [
        'http://a:1',
        'https://b:2',
      ]);
      assert.equal(corsOriginsSchema.safeParse('garbage').success, false);
      assert.equal(corsOriginsSchema.safeParse('').success, false);
    },
  },
  {
    name: 'invalid DOCKER_REGISTRY_URL is ERROR fail-fast without echoing the value',
    run: () => {
      const msg = expectThrow(
        () => validateEnv({ ...baseEnv(), DOCKER_REGISTRY_URL: '::bad::' } as Source),
        /\[env\] DOCKER_REGISTRY_URL/,
        'registry url',
      );
      assert.ok(msg.includes('.env.example'));
      assert.ok(!msg.includes('hunter2'), 'credential leaked into the error');
    },
  },
  {
    name: 'unset DOCKER_REGISTRY_URL warns + skips (never throws)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings(
        without(baseEnv(), 'DOCKER_REGISTRY_URL'),
      );
      assert.equal(env.dockerRegistryUrl, '');
      assert.ok(
        warnings.some((w) => w.includes('DOCKER_REGISTRY_URL') && w.includes('WARN')),
        `expected registry WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'half-set registry basic pair warns (anonymous, never throws, never echoes)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...without(baseEnv(), 'DOCKER_REGISTRY_TOKEN'),
        DOCKER_REGISTRY_USER: 'some-user',
        DOCKER_REGISTRY_PASSWORD: '',
      } as Source);
      assert.equal(env.dockerRegistryUser, 'some-user');
      assert.ok(
        warnings.some((w) => w.includes('partially configured')),
        `expected partial-pair WARN, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        !warnings.some((w) => w.includes('some-user')),
        'credential leaked into warnings',
      );
    },
  },
  {
    name: 'registry token wins over the basic pair with WARN',
    run: () => {
      const { warnings } = validateEnvWithWarnings({
        ...baseEnv(),
        DOCKER_REGISTRY_USER: 'some-user',
        DOCKER_REGISTRY_PASSWORD: 'some-pass',
      } as Source);
      assert.ok(
        warnings.some((w) => w.includes('DOCKER_REGISTRY_TOKEN') && w.includes('ignored')),
        `expected token-priority WARN, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        !warnings.some((w) => w.includes('some-pass')),
        'credential leaked into warnings',
      );
    },
  },
  {
    name: 'registry retry garbage is ERROR without echoing the value',
    run: () => {
      const msg = expectThrow(
        () =>
          validateEnv({
            ...baseEnv(),
            DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS: 'nope',
          } as Source),
        /\[env\] DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS/,
        'registry retry attempts',
      );
      assert.ok(msg.includes('.env.example'));
    },
  },
  {
    name: 'unset registry retry tuning warns with dev defaults',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings(
        without(
          baseEnv(),
          'DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS',
          'DOCKER_REGISTRY_RETRY_BASE_DELAY_MS',
          'DOCKER_REGISTRY_RETRY_MAX_DELAY_MS',
          'DOCKER_REGISTRY_TIMEOUT_MS',
        ),
      );
      assert.equal(env.dockerRegistryRetryMaxAttempts, 3);
      assert.equal(env.dockerRegistryRetryBaseDelayMs, 200);
      assert.equal(env.dockerRegistryRetryMaxDelayMs, 2000);
      assert.equal(env.dockerRegistryTimeoutMs, 10000);
      assert.ok(
        warnings.some((w) => w.includes('DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS')),
        `expected retry WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'missing APP_BACKEND_PORT stays ERROR (PORT legacy fallback works)',
    run: () => {
      expectThrow(
        () => validateEnv(without(baseEnv(), 'APP_BACKEND_PORT')),
        /\[env\] APP_BACKEND_PORT is required/,
        'missing port',
      );
      const env = validateEnv({ ...without(baseEnv(), 'APP_BACKEND_PORT'), PORT: '3000' } as Source);
      assert.equal(env.backendPort, 3000);
    },
  },
  {
    name: 'invalid NPM_REGISTRY_URL is ERROR fail-fast without echoing the value',
    run: () => {
      const msg = expectThrow(
        () => validateEnv({ ...baseEnv(), NPM_REGISTRY_URL: '::bad::' } as Source),
        /\[env\] NPM_REGISTRY_URL/,
        'npm registry url',
      );
      assert.ok(msg.includes('.env.example'));
      assert.ok(!msg.includes('hunter2'), 'credential leaked into the error');
    },
  },
  {
    name: 'unset NPM_REGISTRY_URL warns + skips (never throws)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings(
        without(baseEnv(), 'NPM_REGISTRY_URL'),
      );
      assert.equal(env.npmRegistryUrl, '');
      assert.ok(
        warnings.some((w) => w.includes('NPM_REGISTRY_URL') && w.includes('WARN')),
        `expected npm registry WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'NPM_REGISTRY_TOKEN wins over legacy NPM_TOKEN with WARN (fallback WARN when only legacy)',
    run: () => {
      const secret = 'legacy-npm-token-not-real-never-logged';
      const both = validateEnvWithWarnings({
        ...baseEnv(),
        NPM_TOKEN: secret,
      } as Source);
      assert.equal(both.env.npmRegistryToken, 'test-npm-token-not-real-never-logged');
      assert.ok(
        both.warnings.some((w) => w.includes('NPM_REGISTRY_TOKEN') && w.includes('ignored')),
        `expected token-priority WARN, got: ${JSON.stringify(both.warnings)}`,
      );
      assert.ok(
        !both.warnings.some((w) => w.includes(secret)),
        'credential leaked into warnings',
      );
      const fallback = validateEnvWithWarnings({
        ...without(baseEnv(), 'NPM_REGISTRY_TOKEN'),
        NPM_TOKEN: secret,
      } as Source);
      assert.equal(fallback.env.npmRegistryToken, secret);
      assert.ok(
        fallback.warnings.some((w) => w.includes('NPM_TOKEN') && w.includes('falling back')),
        `expected legacy-fallback WARN, got: ${JSON.stringify(fallback.warnings)}`,
      );
      assert.ok(
        !fallback.warnings.some((w) => w.includes(secret)),
        'credential leaked into warnings',
      );
    },
  },
  {
    name: 'invalid NPM_REGISTRY_SCOPE warns + falls back to @web2bizz (never throws)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...baseEnv(),
        NPM_REGISTRY_SCOPE: 'not-a-scope',
      } as Source);
      assert.equal(env.npmRegistryScope, '@web2bizz');
      assert.ok(
        warnings.some((w) => w.includes('NPM_REGISTRY_SCOPE') && w.includes('WARN')),
        `expected scope WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'npm registry retry garbage is ERROR without echoing the value',
    run: () => {
      const msg = expectThrow(
        () =>
          validateEnv({
            ...baseEnv(),
            NPM_REGISTRY_RETRY_MAX_ATTEMPTS: 'nope',
          } as Source),
        /\[env\] NPM_REGISTRY_RETRY_MAX_ATTEMPTS/,
        'npm registry retry attempts',
      );
      assert.ok(msg.includes('.env.example'));
    },
  },
  {
    name: 'unset npm registry retry tuning warns with dev defaults',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings(
        without(
          baseEnv(),
          'NPM_REGISTRY_RETRY_MAX_ATTEMPTS',
          'NPM_REGISTRY_RETRY_BASE_DELAY_MS',
          'NPM_REGISTRY_RETRY_MAX_DELAY_MS',
          'NPM_REGISTRY_TIMEOUT_MS',
        ),
      );
      assert.equal(env.npmRegistryRetryMaxAttempts, 3);
      assert.equal(env.npmRegistryRetryBaseDelayMs, 200);
      assert.equal(env.npmRegistryRetryMaxDelayMs, 2000);
      assert.equal(env.npmRegistryTimeoutMs, 10000);
      assert.ok(
        warnings.some((w) => w.includes('NPM_REGISTRY_RETRY_MAX_ATTEMPTS')),
        `expected retry WARN, got: ${JSON.stringify(warnings)}`,
      );
    },
  },
  {
    name: 'npm basic USER/PASSWORD passes through trimmed; token wins over basic with WARN',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...without(baseEnv(), 'NPM_REGISTRY_TOKEN', 'NPM_TOKEN'),
        NPM_REGISTRY_USER: '  npm-user  ',
        NPM_REGISTRY_PASSWORD: '  npm-pass  ',
      } as Source);
      assert.equal(env.npmRegistryUser, 'npm-user');
      assert.equal(env.npmRegistryPassword, 'npm-pass');
      assert.deepEqual(
        warnings.filter((w) => w.includes('NPM_REGISTRY_USER')),
        [],
        `complete basic pair must not warn, got: ${JSON.stringify(warnings)}`,
      );
      const clash = validateEnvWithWarnings({
        ...baseEnv(),
        NPM_REGISTRY_USER: 'some-user',
        NPM_REGISTRY_PASSWORD: 'some-pass',
      } as Source);
      assert.ok(
        clash.warnings.some(
          (w) => w.includes('NPM_REGISTRY_TOKEN') && w.includes('NPM_REGISTRY_USER/PASSWORD'),
        ),
        `expected token-over-basic WARN, got: ${JSON.stringify(clash.warnings)}`,
      );
      assert.ok(
        !clash.warnings.some((w) => w.includes('some-pass') || w.includes('some-user')),
        'credential leaked into warnings',
      );
    },
  },
  {
    name: 'half-set npm basic pair warns anonymous (never throws, never echoes)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings({
        ...without(baseEnv(), 'NPM_REGISTRY_TOKEN', 'NPM_TOKEN'),
        NPM_REGISTRY_USER: 'some-user',
        NPM_REGISTRY_PASSWORD: '',
      } as Source);
      assert.equal(env.npmRegistryUser, 'some-user');
      assert.ok(
        warnings.some((w) => w.includes('partially configured')),
        `expected partial-pair WARN, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        !warnings.some((w) => w.includes('some-user')),
        'credential leaked into warnings',
      );
    },
  },
  {
    name: 'JWT secrets unset → ephemeral dev secrets + WARN (never echoes)',
    run: () => {
      const { env, warnings } = validateEnvWithWarnings(
        without(baseEnv(), 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'),
      );
      assert.ok(env.jwtAccessSecret.length >= 32);
      assert.ok(env.jwtRefreshSecret.length >= 32);
      assert.notEqual(env.jwtAccessSecret, env.jwtRefreshSecret);
      assert.ok(
        warnings.some((w) => w.includes('JWT_ACCESS_SECRET') && w.includes('WARN')),
        `expected access WARN, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        warnings.some((w) => w.includes('JWT_REFRESH_SECRET') && w.includes('WARN')),
        `expected refresh WARN, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        !warnings.some((w) => w.includes(env.jwtAccessSecret) || w.includes(env.jwtRefreshSecret)),
        'secret leaked into warnings',
      );
    },
  },
  {
    name: 'short JWT secret is ERROR without echoing the value',
    run: () => {
      const msg = expectThrow(
        () => validateEnv({ ...baseEnv(), JWT_ACCESS_SECRET: 'short-secret' } as Source),
        /\[env\] JWT_ACCESS_SECRET/,
        'short jwt secret',
      );
      assert.ok(msg.includes('.env.example'));
      assert.ok(!msg.includes('short-secret'), 'secret leaked into the error');
    },
  },
  {
    name: 'JWT TTLs parse 15m/7d/seconds; garbage is ERROR',
    run: () => {
      const { env } = validateEnvWithWarnings({
        ...baseEnv(),
        JWT_ACCESS_TTL: '1h',
        JWT_REFRESH_TTL: '3600',
      } as Source);
      assert.equal(env.jwtAccessTtlSec, 3600);
      assert.equal(env.jwtRefreshTtlSec, 3600);
      expectThrow(
        () => validateEnv({ ...baseEnv(), JWT_ACCESS_TTL: 'forever' } as Source),
        /\[env\] JWT_ACCESS_TTL/,
        'bad access ttl',
      );
      expectThrow(
        () => validateEnv({ ...baseEnv(), JWT_REFRESH_TTL: '5' } as Source),
        /\[env\] JWT_REFRESH_TTL/,
        'too-small refresh ttl',
      );
    },
  },
  {
    name: 'AUTH_LEGACY_MOCK_FALLBACK unset → true + WARN; false disables; garbage ERRORs',
    run: () => {
      const unset = validateEnvWithWarnings(without(baseEnv(), 'AUTH_LEGACY_MOCK_FALLBACK'));
      assert.equal(unset.env.authLegacyMockFallback, true);
      assert.ok(
        unset.warnings.some((w) => w.includes('AUTH_LEGACY_MOCK_FALLBACK')),
        `expected fallback WARN, got: ${JSON.stringify(unset.warnings)}`,
      );
      const off = validateEnv({ ...baseEnv(), AUTH_LEGACY_MOCK_FALLBACK: 'false' } as Source);
      assert.equal(off.authLegacyMockFallback, false);
      expectThrow(
        () => validateEnv({ ...baseEnv(), AUTH_LEGACY_MOCK_FALLBACK: 'maybe' } as Source),
        /\[env\] AUTH_LEGACY_MOCK_FALLBACK/,
        'bad fallback flag',
      );
    },
  },
  {
    name: 'ORG_INVITE_TTL_SEC unset → 86400 default + WARN; garbage is ERROR',
    run: () => {
      const unset = validateEnvWithWarnings(without(baseEnv(), 'ORG_INVITE_TTL_SEC'));
      assert.equal(unset.env.orgInviteTtlSec, 86400);
      assert.ok(
        unset.warnings.some((w) => w.includes('ORG_INVITE_TTL_SEC') && w.includes('WARN')),
        `expected invite TTL WARN, got: ${JSON.stringify(unset.warnings)}`,
      );
      const explicit = validateEnv({ ...baseEnv(), ORG_INVITE_TTL_SEC: '3600' } as Source);
      assert.equal(explicit.orgInviteTtlSec, 3600);
      expectThrow(
        () => validateEnv({ ...baseEnv(), ORG_INVITE_TTL_SEC: '10' } as Source),
        /\[env\] ORG_INVITE_TTL_SEC/,
        'too-small invite ttl',
      );
      expectThrow(
        () => validateEnv({ ...baseEnv(), ORG_INVITE_TTL_SEC: 'forever' } as Source),
        /\[env\] ORG_INVITE_TTL_SEC/,
        'bad invite ttl',
      );
    },
  },
  {
    name: 'OPENCODE_KEYS_ENCRYPTION_KEY unset → empty + WARN; short is ERROR without echo',
    run: () => {
      const unset = validateEnvWithWarnings(without(baseEnv(), 'OPENCODE_KEYS_ENCRYPTION_KEY'));
      assert.equal(unset.env.opencodeKeysEncryptionKey, '');
      assert.ok(
        unset.warnings.some((w) => w.includes('OPENCODE_KEYS_ENCRYPTION_KEY') && w.includes('WARN')),
        `expected encryption-key WARN, got: ${JSON.stringify(unset.warnings)}`,
      );
      const msg = expectThrow(
        () => validateEnv({ ...baseEnv(), OPENCODE_KEYS_ENCRYPTION_KEY: 'too-short' } as Source),
        /\[env\] OPENCODE_KEYS_ENCRYPTION_KEY/,
        'short encryption key',
      );
      assert.ok(msg.includes('.env.example'));
      assert.ok(!msg.includes('too-short'), 'secret leaked into the error');
    },
  },
  {
    name: 'OPENCODE_KEYS rotation vars: defaults v1/v0 + empty previous; explicit ok; short previous ERROR; bad id ERROR',
    run: () => {
      const unset = validateEnvWithWarnings(
        without(
          baseEnv(),
          'OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS',
          'OPENCODE_KEYS_ACTIVE_KEY_ID',
          'OPENCODE_KEYS_PREVIOUS_KEY_ID',
        ),
      );
      assert.equal(unset.env.opencodeKeysEncryptionKeyPrevious, '');
      assert.equal(unset.env.opencodeKeysActiveKeyId, 'v1');
      assert.equal(unset.env.opencodeKeysPreviousKeyId, 'v0');
      const explicit = validateEnv({
        ...baseEnv(),
        OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS:
          'test-opencode-keys-previous-key-not-real-0123456789',
        OPENCODE_KEYS_ACTIVE_KEY_ID: 'v2',
        OPENCODE_KEYS_PREVIOUS_KEY_ID: 'v1',
      } as Source);
      assert.equal(
        explicit.opencodeKeysEncryptionKeyPrevious,
        'test-opencode-keys-previous-key-not-real-0123456789',
      );
      assert.equal(explicit.opencodeKeysActiveKeyId, 'v2');
      assert.equal(explicit.opencodeKeysPreviousKeyId, 'v1');
      const prevWarn = validateEnvWithWarnings({
        ...baseEnv(),
        OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS:
          'test-opencode-keys-previous-key-not-real-0123456789',
      } as Source);
      assert.ok(
        prevWarn.warnings.some(
          (w) => w.includes('OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS') && w.includes('WARN'),
        ),
        `expected previous-key rotation WARN, got: ${JSON.stringify(prevWarn.warnings)}`,
      );
      const shortMsg = expectThrow(
        () =>
          validateEnv({
            ...baseEnv(),
            OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS: 'too-short',
          } as Source),
        /\[env\] OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS/,
        'short previous key',
      );
      assert.ok(!shortMsg.includes('too-short'), 'secret leaked into the error');
      expectThrow(
        () => validateEnv({ ...baseEnv(), OPENCODE_KEYS_ACTIVE_KEY_ID: 'bad id!' } as Source),
        /\[env\] OPENCODE_KEYS_ACTIVE_KEY_ID/,
        'bad active key id',
      );
      // Empty id falls back to the default (never throws — ids are non-secret).
      const emptyId = validateEnv({ ...baseEnv(), OPENCODE_KEYS_PREVIOUS_KEY_ID: '' } as Source);
      assert.equal(emptyId.opencodeKeysPreviousKeyId, 'v0');
    },
  },
];

let failed = 0;
for (const c of checks) {
  try {
    c.run();
    console.log(`ok - ${c.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
  }
}
if (failed > 0) {
  console.error(`${failed}/${checks.length} env checks failed`);
  process.exitCode = 1;
} else {
  console.log(`${checks.length}/${checks.length} env checks passed`);
}
