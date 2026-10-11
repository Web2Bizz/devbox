/**
 * docker-registry unit checks — self-contained runner (no new deps, plain node:assert).
 *
 * Covers: auth-header priority (token wins over the basic pair, secrets never
 * logged), retry/backoff policy (GET retries with exponential backoff, POST
 * runs once), soft start (unreachable registry settles on 'down' without
 * throwing; unconfigured settles on 'skipped'), catalog 503 envelope
 * (EXTERNAL_UNAVAILABLE + Retry-After 30 via ApiErrorFilter), and the
 * never-log-secrets rule for DOCKER_REGISTRY_* values.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/docker-registry/docker-registry.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 */
import assert from 'node:assert/strict';
import { AppLogger } from '../common/app-logger.service.js';
import { ApiErrorFilter } from '../common/api-error.filter.js';
import { ExternalClient } from '../common/external/external-client.js';
import { ExternalServiceError } from '../common/external/external-error.js';
import { computeBackoffDelay, withRetry } from '../common/external/retry.js';
import {
  dockerRegistryAuthHeaders,
  resolveDockerRegistryConfig,
} from './docker-registry.config.js';
import { DockerRegistryService } from './docker-registry.service.js';
import { validateEnv } from '../env.js';

const SECRET_TOKEN = 'super-secret-token-xyz-never-log';
const SECRET_PASS = 'super-secret-pass-xyz-never-log';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    APP_BACKEND_PORT: '3000',
    OPENCODE_URL: 'http://127.0.0.1:9',
    DATABASE_URL: '',
    EXTERNAL_RETRY_MAX_ATTEMPTS: '1',
    EXTERNAL_RETRY_BASE_DELAY_MS: '0',
    EXTERNAL_RETRY_MAX_DELAY_MS: '0',
    DOCKER_REGISTRY_URL: 'http://127.0.0.1:9',
    DOCKER_REGISTRY_TIMEOUT_MS: '200',
    DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS: '2',
    DOCKER_REGISTRY_RETRY_BASE_DELAY_MS: '1',
    DOCKER_REGISTRY_RETRY_MAX_DELAY_MS: '1',
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
    'DOCKER_REGISTRY_URL',
    'DOCKER_REGISTRY_USER',
    'DOCKER_REGISTRY_PASSWORD',
    'DOCKER_REGISTRY_TOKEN',
    'DOCKER_REGISTRY_TIMEOUT_MS',
    'DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS',
    'DOCKER_REGISTRY_RETRY_BASE_DELAY_MS',
    'DOCKER_REGISTRY_RETRY_MAX_DELAY_MS',
  ]) {
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string') process.env[k] = v;
  }
}

function makeService(): DockerRegistryService {
  return new DockerRegistryService(
    undefined,
    new AppLogger('DockerRegistrySpec'),
    new ExternalClient(new AppLogger('ExternalClientSpec')),
  );
}

const checks: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: 'token auth wins over the basic pair (never logged)',
    run: () => {
      const headers = dockerRegistryAuthHeaders({
        url: 'http://127.0.0.1:5000',
        user: 'some-user',
        password: SECRET_PASS,
        token: SECRET_TOKEN,
        timeoutMs: 200,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      });
      assert.equal(headers['authorization'], `Bearer ${SECRET_TOKEN}`);
    },
  },
  {
    name: 'complete basic pair yields a Basic header; anonymous yields none',
    run: () => {
      const basic = dockerRegistryAuthHeaders({
        url: 'http://127.0.0.1:5000',
        user: 'some-user',
        password: SECRET_PASS,
        token: '',
        timeoutMs: 200,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      });
      assert.equal(
        basic['authorization'],
        `Basic ${Buffer.from(`some-user:${SECRET_PASS}`).toString('base64')}`,
      );
      const anon = dockerRegistryAuthHeaders({
        url: 'http://127.0.0.1:5000',
        user: '',
        password: '',
        token: '',
        timeoutMs: 200,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      });
      assert.deepEqual(anon, {});
    },
  },
  {
    name: 'env resolves into the registry config (token kept, never echoed)',
    run: () => {
      applyEnv({ ...baseEnv(), DOCKER_REGISTRY_TOKEN: SECRET_TOKEN });
      const env = validateEnv(process.env);
      const cfg = resolveDockerRegistryConfig(env);
      assert.equal(cfg.url, 'http://127.0.0.1:9');
      assert.equal(cfg.token, SECRET_TOKEN);
      assert.equal(cfg.timeoutMs, 200);
      assert.equal(cfg.retry.maxAttempts, 2);
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
      applyEnv({ ...baseEnv(), DOCKER_REGISTRY_TOKEN: SECRET_TOKEN });
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
      delete env['DOCKER_REGISTRY_URL'];
      applyEnv(env as NodeJS.ProcessEnv);
      const svc = makeService();
      await svc.onModuleInit(); // must not throw
      assert.equal(svc.currentStatus, 'skipped');
      assert.equal(await svc.checkConnectivity(50), 'skipped');
    },
  },
  {
    name: 'catalog on skipped/down throws 503 EXTERNAL_UNAVAILABLE without secrets',
    run: async () => {
      const env = { ...baseEnv(), DOCKER_REGISTRY_TOKEN: SECRET_TOKEN } as Record<string, string>;
      delete env['DOCKER_REGISTRY_URL'];
      applyEnv(env as NodeJS.ProcessEnv);
      const skipped = makeService();
      const err = await skipped.listCatalog('cid-1').then(
        () => null,
        (e: unknown) => e as ExternalServiceError,
      );
      assert.ok(err instanceof ExternalServiceError);
      assert.equal(err.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(err.httpStatus, 503);
      assert.ok(!err.message.includes(SECRET_TOKEN), 'secret leaked into the message');

      applyEnv({ ...baseEnv(), DOCKER_REGISTRY_TOKEN: SECRET_TOKEN });
      const down = makeService();
      const err2 = await down.listCatalog('cid-2').then(
        () => null,
        (e: unknown) => e as ExternalServiceError,
      );
      assert.ok(err2 instanceof ExternalServiceError);
      assert.equal(err2.httpStatus, 503);
      assert.ok(!err2.message.includes(SECRET_TOKEN), 'secret leaked into the message');
    },
  },
  {
    name: 'ApiErrorFilter answers registry 503 with envelope + Retry-After 30',
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
          service: 'docker-registry',
          operation: 'listCatalog',
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
      // eslint-disable-next-line no-console
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`${failed}/${checks.length} docker-registry checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} docker-registry checks failed`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${checks.length}/${checks.length} docker-registry checks passed`);
  }
}

void main();
