/**
 * npm-registry unit checks — self-contained runner (no new deps, plain node:assert).
 *
 * Covers: Bearer auth header (token wins over the basic pair), Basic
 * USER/PASSWORD header, anonymous yields none (secrets never logged),
 * NPM_TOKEN legacy fallback (NPM_REGISTRY_TOKEN wins), retry/backoff policy
 * (GET retries with exponential backoff, POST runs once), soft start
 * (unreachable registry settles on 'down' without throwing; unconfigured
 * settles on 'skipped'; 401/403 at boot settle on 'down' with AUTH_401/AUTH_403),
 * status 503 neutral envelope (EXTERNAL_UNAVAILABLE + Retry-After 30 via
 * ApiErrorFilter — 401 bad-credentials / 403 forbidden never leak outward),
 * ping-level 401/403 counting as 'down' (auth refused), and the
 * never-log-secrets rule for NPM_REGISTRY_* values.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/npm-registry/npm-registry.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AppLogger } from '../common/app-logger.service.js';
import { ApiErrorFilter } from '../common/api-error.filter.js';
import { ExternalClient } from '../common/external/external-client.js';
import { ExternalServiceError } from '../common/external/external-error.js';
import { computeBackoffDelay, withRetry } from '../common/external/retry.js';
import {
  hasNpmBasicPair,
  npmRegistryAuthHeaders,
  npmRegistryAuthMode,
  resolveNpmRegistryConfig,
} from './npm-registry.config.js';
import { NpmRegistryService } from './npm-registry.service.js';
import { validateEnv } from '../env.js';

const SECRET_TOKEN = 'super-secret-npm-token-xyz-never-log';
const SECRET_USER = 'super-secret-npm-user-never-log';
const SECRET_PASSWORD = 'super-secret-npm-pass-never-log';
const LEGACY_TOKEN = 'legacy-npm-token-xyz-never-log';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    APP_BACKEND_PORT: '3000',
    OPENCODE_URL: 'http://127.0.0.1:9',
    DATABASE_URL: '',
    EXTERNAL_RETRY_MAX_ATTEMPTS: '1',
    EXTERNAL_RETRY_BASE_DELAY_MS: '0',
    EXTERNAL_RETRY_MAX_DELAY_MS: '0',
    NPM_REGISTRY_URL: 'http://127.0.0.1:9',
    NPM_REGISTRY_SCOPE: '@web2bizz',
    NPM_REGISTRY_TIMEOUT_MS: '200',
    NPM_REGISTRY_RETRY_MAX_ATTEMPTS: '2',
    NPM_REGISTRY_RETRY_BASE_DELAY_MS: '1',
    NPM_REGISTRY_RETRY_MAX_DELAY_MS: '1',
  } as NodeJS.ProcessEnv;
}

function applyEnv(source: NodeJS.ProcessEnv): void {
  for (const key of [
    'APP_BACKEND_PORT',
    'OPENCODE_URL',
    'DATABASE_URL',
    'EXTERNAL_RETRY_MAX_ATTEMPTS',
    'EXTERNAL_RETRY_BASE_DELAY_MS',
    'EXTERNAL_RETRY_MAX_DELAY_MS',
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
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string') process.env[k] = v;
  }
}

function makeService(): NpmRegistryService {
  return new NpmRegistryService(
    undefined,
    new AppLogger('NpmRegistrySpec'),
    new ExternalClient(new AppLogger('ExternalClientSpec')),
  );
}

const checks: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: 'Bearer token yields an Authorization header; anonymous yields none',
    run: () => {
      const authed = npmRegistryAuthHeaders({
        url: 'https://npm.registry.web2bizz.team',
        token: SECRET_TOKEN,
        user: '',
        password: '',
        scope: '@web2bizz',
        timeoutMs: 200,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      });
      assert.equal(authed['authorization'], `Bearer ${SECRET_TOKEN}`);
      const anon = npmRegistryAuthHeaders({
        url: 'https://npm.registry.web2bizz.team',
        token: '',
        user: '',
        password: '',
        scope: '@web2bizz',
        timeoutMs: 200,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      });
      assert.deepEqual(anon, {});
    },
  },
  {
    name: 'basic USER/PASSWORD yields a Basic header; token wins over the pair',
    run: () => {
      const basic = npmRegistryAuthHeaders({
        url: 'https://npm.registry.web2bizz.team',
        token: '',
        user: SECRET_USER,
        password: SECRET_PASSWORD,
        scope: '@web2bizz',
        timeoutMs: 200,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      });
      assert.equal(
        basic['authorization'],
        `Basic ${Buffer.from(`${SECRET_USER}:${SECRET_PASSWORD}`).toString('base64')}`,
      );
      assert.equal(
        npmRegistryAuthMode({ token: '', user: SECRET_USER, password: SECRET_PASSWORD }),
        'basic',
      );
      assert.ok(
        hasNpmBasicPair({
          url: 'https://npm.registry.web2bizz.team',
          token: '',
          user: SECRET_USER,
          password: SECRET_PASSWORD,
          scope: '@web2bizz',
          timeoutMs: 200,
          retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        }),
      );
      // Half-set pair → anonymous (no header), token mode → token fact.
      assert.deepEqual(
        npmRegistryAuthHeaders({
          url: 'https://npm.registry.web2bizz.team',
          token: '',
          user: SECRET_USER,
          password: '',
          scope: '@web2bizz',
          timeoutMs: 200,
          retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        }),
        {},
      );
      const winner = npmRegistryAuthHeaders({
        url: 'https://npm.registry.web2bizz.team',
        token: SECRET_TOKEN,
        user: SECRET_USER,
        password: SECRET_PASSWORD,
        scope: '@web2bizz',
        timeoutMs: 200,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      });
      assert.equal(winner['authorization'], `Bearer ${SECRET_TOKEN}`);
      assert.equal(
        npmRegistryAuthMode({ token: SECRET_TOKEN, user: SECRET_USER, password: SECRET_PASSWORD }),
        'token',
      );
    },
  },
  {
    name: 'env resolves into the npm config (explicit token wins, legacy fallback works, basic pair passes through)',
    run: () => {
      applyEnv({ ...baseEnv(), NPM_REGISTRY_TOKEN: SECRET_TOKEN, NPM_TOKEN: LEGACY_TOKEN });
      const env = validateEnv(process.env);
      const cfg = resolveNpmRegistryConfig(env);
      assert.equal(cfg.url, 'http://127.0.0.1:9');
      assert.equal(cfg.token, SECRET_TOKEN);
      assert.equal(cfg.user, '');
      assert.equal(cfg.password, '');
      assert.equal(cfg.scope, '@web2bizz');
      assert.equal(cfg.timeoutMs, 200);
      assert.equal(cfg.retry.maxAttempts, 2);

      applyEnv({ ...baseEnv(), NPM_TOKEN: LEGACY_TOKEN });
      const fallback = resolveNpmRegistryConfig(validateEnv(process.env));
      assert.equal(fallback.token, LEGACY_TOKEN);

      applyEnv({
        ...baseEnv(),
        NPM_REGISTRY_USER: SECRET_USER,
        NPM_REGISTRY_PASSWORD: SECRET_PASSWORD,
      });
      const basicEnv = validateEnv(process.env);
      assert.equal(basicEnv.npmRegistryUser, SECRET_USER);
      assert.equal(basicEnv.npmRegistryPassword, SECRET_PASSWORD);
      const basicCfg = resolveNpmRegistryConfig(basicEnv);
      assert.equal(basicCfg.user, SECRET_USER);
      assert.equal(basicCfg.password, SECRET_PASSWORD);
      // Trimmed (optional trim): surrounding spaces never reach the config.
      applyEnv({
        ...baseEnv(),
        NPM_REGISTRY_USER: `  ${SECRET_USER}  `,
        NPM_REGISTRY_PASSWORD: `  ${SECRET_PASSWORD}  `,
      });
      const trimmed = resolveNpmRegistryConfig(validateEnv(process.env));
      assert.equal(trimmed.user, SECRET_USER);
      assert.equal(trimmed.password, SECRET_PASSWORD);
    },
  },
  {
    name: 'invalid scope falls back to @web2bizz (never throws)',
    run: () => {
      applyEnv({ ...baseEnv(), NPM_REGISTRY_SCOPE: 'not-a-scope' });
      const env = validateEnv(process.env);
      assert.equal(env.npmRegistryScope, '@web2bizz');
    },
  },
  {
    name: 'backoff is exponential and capped (deterministic, jitter off)',
    run: () => {
      assert.equal(computeBackoffDelay(1, 200, 2000, false), 200);
      assert.equal(computeBackoffDelay(2, 200, 2000, false), 400);
      assert.equal(computeBackoffDelay(3, 200, 2000, false), 800);
      assert.equal(computeBackoffDelay(10, 200, 500, false), 500);
    },
  },
  {
    name: 'withRetry retries GET then succeeds; POST runs exactly once',
    run: async () => {
      let getAttempts = 0;
      const ok = await withRetry(
        async (attempt) => {
          getAttempts = attempt;
          if (attempt < 3) throw new Error('fetch failed (flaky)');
          return 'live';
        },
        { method: 'GET', maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
      );
      assert.equal(ok, 'live');
      assert.equal(getAttempts, 3);
      let postAttempts = 0;
      await withRetry(
        async () => {
          postAttempts += 1;
          return 'once';
        },
        { method: 'POST', maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
      );
      assert.equal(postAttempts, 1);
    },
  },
  {
    name: 'soft start: unreachable registry settles on down without throwing',
    run: async () => {
      applyEnv({ ...baseEnv(), NPM_REGISTRY_TOKEN: SECRET_TOKEN });
      const svc = makeService();
      await svc.onModuleInit(); // must not throw
      assert.equal(svc.currentStatus, 'down');
      const snap = svc.snapshot;
      assert.equal(snap.status, 'down');
      assert.ok(snap.lastCheckAt, 'lastCheckAt must be stamped');
      assert.ok(snap.lastError, 'lastError must be stamped');
      assert.ok(!String(snap.lastError).includes(SECRET_TOKEN), 'secret leaked into lastError');
      assert.ok(!String(snap.lastCheckAt).includes(SECRET_TOKEN), 'secret leaked into lastCheckAt');
    },
  },
  {
    name: 'soft start: unconfigured registry settles on skipped',
    run: async () => {
      const env = { ...baseEnv() } as Record<string, string>;
      delete env['NPM_REGISTRY_URL'];
      applyEnv(env as NodeJS.ProcessEnv);
      const svc = makeService();
      await svc.onModuleInit(); // must not throw
      assert.equal(svc.currentStatus, 'skipped');
      assert.equal(await svc.checkConnectivity(50), 'skipped');
    },
  },
  {
    name: 'status on skipped/down throws 503 EXTERNAL_UNAVAILABLE without secrets',
    run: async () => {
      const env = { ...baseEnv(), NPM_REGISTRY_TOKEN: SECRET_TOKEN } as Record<string, string>;
      delete env['NPM_REGISTRY_URL'];
      applyEnv(env as NodeJS.ProcessEnv);
      const skipped = makeService();
      const err = await skipped.getStatusOrThrow('cid-1').then(
        () => null,
        (e: unknown) => e as ExternalServiceError,
      );
      assert.ok(err instanceof ExternalServiceError);
      assert.equal(err.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(err.httpStatus, 503);
      assert.ok(!err.message.includes(SECRET_TOKEN), 'secret leaked into the message');

      applyEnv({ ...baseEnv(), NPM_REGISTRY_TOKEN: SECRET_TOKEN });
      const down = makeService();
      const err2 = await down.getStatusOrThrow('cid-2').then(
        () => null,
        (e: unknown) => e as ExternalServiceError,
      );
      assert.ok(err2 instanceof ExternalServiceError);
      assert.equal(err2.httpStatus, 503);
      assert.ok(!err2.message.includes(SECRET_TOKEN), 'secret leaked into the message');
    },
  },
  {
    name: 'ping-level 401 settles on down(AUTH_401): 503 neutral outward, reason only in snapshot',
    run: async () => {
      const stub = await new Promise<{ server: Server; url: string }>((resolve) => {
        const server = createServer((req, res) => {
          if (req.url === '/-/ping' || req.url?.startsWith('/-/ping?')) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve({ server, url: `http://127.0.0.1:${port}` });
        });
      });
      try {
        applyEnv({ ...baseEnv(), NPM_REGISTRY_URL: stub.url, NPM_REGISTRY_TOKEN: SECRET_TOKEN });
        const svc = makeService();
        await svc.onModuleInit(); // must not throw
        assert.equal(svc.currentStatus, 'down');
        assert.equal(svc.snapshot.lastError, 'AUTH_401');
        assert.equal(await svc.checkConnectivity(500), 'down');
        const err = await svc.getStatusOrThrow('cid-401').then(
          () => null,
          (e: unknown) => e as ExternalServiceError,
        );
        assert.ok(err instanceof ExternalServiceError);
        assert.equal(err.code, 'EXTERNAL_UNAVAILABLE');
        assert.equal(err.httpStatus, 503);
        assert.equal(err.message, 'сервис временно недоступен, повторите позже');
        assert.ok(!JSON.stringify(err).includes(SECRET_TOKEN), 'secret leaked');
        assert.ok(!err.message.includes('401'), 'upstream 401 leaked outward');
      } finally {
        await new Promise<void>((resolve) => stub.server.close(() => resolve()));
      }
    },
  },
  {
    name: 'ping-level 403 settles on down(AUTH_403): 503 neutral outward, basic secrets never leak',
    run: async () => {
      const stub = await new Promise<{ server: Server; url: string }>((resolve) => {
        const server = createServer((req, res) => {
          if (req.url === '/-/ping' || req.url?.startsWith('/-/ping?')) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            return;
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve({ server, url: `http://127.0.0.1:${port}` });
        });
      });
      try {
        applyEnv({
          ...baseEnv(),
          NPM_REGISTRY_URL: stub.url,
          NPM_REGISTRY_USER: SECRET_USER,
          NPM_REGISTRY_PASSWORD: SECRET_PASSWORD,
        });
        const svc = makeService();
        await svc.onModuleInit(); // must not throw
        assert.equal(svc.currentStatus, 'down');
        assert.equal(svc.snapshot.lastError, 'AUTH_403');
        assert.ok(!String(svc.snapshot.lastError).includes(SECRET_PASSWORD), 'secret leaked');
        assert.equal(await svc.checkConnectivity(500), 'down');
        const err = await svc.getStatusOrThrow('cid-403').then(
          () => null,
          (e: unknown) => e as ExternalServiceError,
        );
        assert.ok(err instanceof ExternalServiceError);
        assert.equal(err.code, 'EXTERNAL_UNAVAILABLE');
        assert.equal(err.httpStatus, 503);
        assert.equal(err.message, 'сервис временно недоступен, повторите позже');
        assert.ok(!JSON.stringify(err).includes(SECRET_USER), 'user leaked');
        assert.ok(!JSON.stringify(err).includes(SECRET_PASSWORD), 'password leaked');
      } finally {
        await new Promise<void>((resolve) => stub.server.close(() => resolve()));
      }
    },
  },
  {
    name: 'basic USER/PASSWORD against a 200 stub flips to up (Authorization Basic really sent)',
    run: async () => {
      const expected = `Basic ${Buffer.from(`${SECRET_USER}:${SECRET_PASSWORD}`).toString('base64')}`;
      const stub = await new Promise<{ server: Server; url: string }>((resolve) => {
        const server = createServer((req, res) => {
          if (req.url === '/-/ping' || req.url?.startsWith('/-/ping?')) {
            if ((req.headers['authorization'] ?? '') !== expected) {
              res.writeHead(401, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'unauthorized' }));
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve({ server, url: `http://127.0.0.1:${port}` });
        });
      });
      try {
        applyEnv({
          ...baseEnv(),
          NPM_REGISTRY_URL: stub.url,
          NPM_REGISTRY_USER: SECRET_USER,
          NPM_REGISTRY_PASSWORD: SECRET_PASSWORD,
        });
        const svc = makeService();
        assert.equal(await svc.checkConnectivity(1000), 'up');
        const payload = await svc.getStatusOrThrow('cid-basic');
        assert.equal(payload.status, 'up');
        assert.equal(payload.url, stub.url);
        assert.ok(!JSON.stringify(payload).includes(SECRET_PASSWORD), 'password leaked');
      } finally {
        await new Promise<void>((resolve) => stub.server.close(() => resolve()));
      }
    },
  },
  {
    name: 'ApiErrorFilter answers npm 503 with envelope + Retry-After 30',
    run: () => {
      const filter = new ApiErrorFilter();
      const headers: Record<string, string> = {};
      let statusCode = 0;
      let body: unknown = null;
      const res = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (b: unknown) => {
              body = b;
            },
          };
        },
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      };
      const req = { headers: {} };
      filter.catch(
        new ExternalServiceError({
          code: 'EXTERNAL_UNAVAILABLE',
          service: 'npm-registry',
          operation: 'getStatus',
          message: 'сервис временно недоступен, повторите позже',
        }),
        { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as never,
      );
      assert.equal(statusCode, 503);
      assert.equal(headers['Retry-After'], '30');
      const envelope = body as { code?: string; message?: string; correlationId?: string };
      assert.equal(envelope.code, 'EXTERNAL_UNAVAILABLE');
      assert.ok(envelope.correlationId, 'correlationId must be echoed');
      assert.ok(!JSON.stringify(envelope).includes(SECRET_TOKEN), 'secret leaked into envelope');
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} npm-registry checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} npm-registry checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} npm-registry checks passed`);
  }
}

void main();
