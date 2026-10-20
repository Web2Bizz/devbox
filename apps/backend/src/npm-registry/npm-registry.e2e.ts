/**
 * npm-registry e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/npm-registry/npm-registry.e2e.js`
 *
 * Covers, per phase (down / skipped / up-token / up-basic / 401 / 403):
 * - GET /health stays 200 with the npmRegistry flag (down/skipped/up);
 * - GET /api/v1/registry/npm/status answers 503 { code, message, correlationId }
 *   + Retry-After 30 when down/skipped/auth-refused, and 200 with live
 *   { status, url, scope } when the stub Verdaccio answers 2xx with valid
 *   credentials (no mock 200s — 200 always means live data);
 * - auth priority: TOKEN (Bearer) wins, else USER/PASSWORD (Basic); the stub
 *   enforces the expected Authorization header on the ok phases (wrong or
 *   missing auth → 401, proving the client really sent it);
 * - a stub answering 401 (bad credentials) or 403 (forbidden) on /-/ping
 *   counts as 'down' — status answers 503 EXTERNAL_UNAVAILABLE with the
 *   neutral message (no 401/403 detail outward, Retry-After 30);
 * - the envelope never carries NPM_REGISTRY_* secret values (token/user/pass).
 * Never logs secrets; reports db 'down' (strict Postgres) + opencode 'down' (no external net).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

// --- deterministic env (overrides repo .env; applied BEFORE AppModule import,
// ConfigModule.validate runs at import/factory time, dynamic imports below) --
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
process.env.OPENCODE_URL = 'http://127.0.0.1:9';
process.env.DATABASE_URL = '';
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST']) {
  delete process.env[key];
}
process.env.NPM_REGISTRY_TIMEOUT_MS = '1000';
process.env.NPM_REGISTRY_SCOPE = '@web2bizz';
process.env.NPM_REGISTRY_RETRY_MAX_ATTEMPTS = '1';
process.env.NPM_REGISTRY_RETRY_BASE_DELAY_MS = '0';
process.env.NPM_REGISTRY_RETRY_MAX_DELAY_MS = '0';
process.env.EXTERNAL_RETRY_MAX_ATTEMPTS = '1';
process.env.EXTERNAL_RETRY_BASE_DELAY_MS = '0';
process.env.EXTERNAL_RETRY_MAX_DELAY_MS = '0';

const SECRET_TOKEN = 'e2e-secret-npm-token-xyz-never-log';
const SECRET_USER = 'e2e-npm-user-never-log';
const SECRET_PASSWORD = 'e2e-npm-pass-never-log';
const NEUTRAL_MESSAGE = 'сервис временно недоступен, повторите позже';

function clearNpmAuthEnv(): void {
  delete process.env.NPM_REGISTRY_TOKEN;
  delete process.env.NPM_TOKEN;
  delete process.env.NPM_REGISTRY_USER;
  delete process.env.NPM_REGISTRY_PASSWORD;
}

function secretsLeaked(payload: unknown): boolean {
  const text = JSON.stringify(payload);
  return (
    text.includes(SECRET_TOKEN) || text.includes(SECRET_USER) || text.includes(SECRET_PASSWORD)
  );
}

type StubOptions = {
  /** Fixed status for /-/ping (used for the 401/403 phases). */
  pingStatus?: number;
  /** When set, /-/ping answers 200 only with this exact Authorization value, else 401. */
  expectAuth?: string;
};

function startStubVerdaccio(options: StubOptions = {}): Promise<{ server: Server; url: string }> {
  const { pingStatus, expectAuth } = options;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/-/ping' || req.url?.startsWith('/-/ping?')) {
        if (pingStatus === 401 || pingStatus === 403) {
          res.writeHead(pingStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: pingStatus === 401 ? 'unauthorized' : 'forbidden' }));
          return;
        }
        if (expectAuth !== undefined) {
          const got = req.headers['authorization'] ?? '';
          if (got !== expectAuth) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
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
}

async function main(): Promise<void> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../app.setup');

  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      passed += 1;
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL - ${name}: ${(err as Error).message}`);
    }
  }

  async function boot(): Promise<{ app: { close: () => Promise<void> }; base: string }> {
    const app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    const base = await app.getUrl();
    return { app, base };
  }

  const readJson = async (res: Response): Promise<unknown> =>
    (await res.json().catch(() => null)) as unknown;

  // --- phase 1: down (unreachable URL, soft start must not throw) ------------
  process.env.NPM_REGISTRY_URL = 'http://127.0.0.1:9';
  process.env.NPM_REGISTRY_TOKEN = SECRET_TOKEN;
  {
    const { app, base } = await boot();
    try {
      await check('down: GET /health is 200 with npmRegistry=down', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { npmRegistry?: string };
        assert.equal(body.npmRegistry, 'down');
      });

      await check('down: GET /api/v1/registry/npm/status is 503 neutral + Retry-After', async () => {
        const res = await fetch(`${base}/api/v1/registry/npm/status`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('retry-after'), '30');
        const body = (await readJson(res)) as {
          code?: string;
          message?: string;
          correlationId?: string;
        };
        assert.equal(body.code, 'EXTERNAL_UNAVAILABLE');
        assert.equal(body.message, NEUTRAL_MESSAGE);
        assert.ok(body.correlationId, 'correlationId must be echoed');
        assert.ok(!secretsLeaked(body), 'secret leaked into envelope');
      });
    } finally {
      await app.close();
    }
  }

  // --- phase 2: skipped (URL unset) ------------------------------------------
  delete process.env.NPM_REGISTRY_URL;
  clearNpmAuthEnv();
  {
    const { app, base } = await boot();
    try {
      await check('skipped: GET /health is 200 with npmRegistry=skipped', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { npmRegistry?: string };
        assert.equal(body.npmRegistry, 'skipped');
      });

      await check('skipped: GET /api/v1/registry/npm/status is 503 neutral', async () => {
        const res = await fetch(`${base}/api/v1/registry/npm/status`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('retry-after'), '30');
        const body = (await readJson(res)) as { code?: string; message?: string };
        assert.equal(body.code, 'EXTERNAL_UNAVAILABLE');
        assert.equal(body.message, NEUTRAL_MESSAGE);
      });
    } finally {
      await app.close();
    }
  }

  // --- phase 3: up via TOKEN (stub enforces Bearer) ---------------------------
  const tokenStub = await startStubVerdaccio({ expectAuth: `Bearer ${SECRET_TOKEN}` });
  process.env.NPM_REGISTRY_URL = tokenStub.url;
  process.env.NPM_REGISTRY_TOKEN = SECRET_TOKEN;
  delete process.env.NPM_REGISTRY_USER;
  delete process.env.NPM_REGISTRY_PASSWORD;
  {
    const { app, base } = await boot();
    try {
      await check('up-token: GET /health is 200 with npmRegistry=up', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { npmRegistry?: string };
        assert.equal(body.npmRegistry, 'up');
      });

      await check('up-token: GET /api/v1/registry/npm/status is 200 with live payload', async () => {
        const res = await fetch(`${base}/api/v1/registry/npm/status`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { status?: unknown; url?: unknown; scope?: unknown };
        assert.equal(body.status, 'up');
        assert.equal(body.url, tokenStub.url);
        assert.equal(body.scope, '@web2bizz');
        assert.ok(!secretsLeaked(body), 'secret leaked into payload');
      });
    } finally {
      await app.close();
    }
  }
  await new Promise<void>((resolve) => tokenStub.server.close(() => resolve()));

  // --- phase 4: up via USER/PASSWORD Basic (stub enforces Basic) --------------
  const basicAuth = `Basic ${Buffer.from(`${SECRET_USER}:${SECRET_PASSWORD}`).toString('base64')}`;
  const basicStub = await startStubVerdaccio({ expectAuth: basicAuth });
  process.env.NPM_REGISTRY_URL = basicStub.url;
  clearNpmAuthEnv();
  process.env.NPM_REGISTRY_USER = SECRET_USER;
  process.env.NPM_REGISTRY_PASSWORD = SECRET_PASSWORD;
  {
    const { app, base } = await boot();
    try {
      await check('up-basic: GET /health is 200 with npmRegistry=up', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { npmRegistry?: string };
        assert.equal(body.npmRegistry, 'up');
      });

      await check('up-basic: GET /api/v1/registry/npm/status is 200 with live payload', async () => {
        const res = await fetch(`${base}/api/v1/registry/npm/status`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { status?: unknown; url?: unknown; scope?: unknown };
        assert.equal(body.status, 'up');
        assert.equal(body.url, basicStub.url);
        assert.equal(body.scope, '@web2bizz');
        assert.ok(!secretsLeaked(body), 'secret leaked into payload');
      });
    } finally {
      await app.close();
    }
  }
  await new Promise<void>((resolve) => basicStub.server.close(() => resolve()));

  // --- phase 5: 401 bad credentials → down + 503 neutral ----------------------
  const stub401 = await startStubVerdaccio({ pingStatus: 401 });
  process.env.NPM_REGISTRY_URL = stub401.url;
  process.env.NPM_REGISTRY_TOKEN = SECRET_TOKEN;
  delete process.env.NPM_REGISTRY_USER;
  delete process.env.NPM_REGISTRY_PASSWORD;
  {
    const { app, base } = await boot();
    try {
      await check('401: GET /health is 200 with npmRegistry=down', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { npmRegistry?: string };
        assert.equal(body.npmRegistry, 'down');
      });

      await check('401: status is 503 neutral (no 401 outward) + Retry-After', async () => {
        const res = await fetch(`${base}/api/v1/registry/npm/status`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('retry-after'), '30');
        const body = (await readJson(res)) as {
          code?: string;
          message?: string;
          correlationId?: string;
        };
        assert.equal(body.code, 'EXTERNAL_UNAVAILABLE');
        assert.equal(body.message, NEUTRAL_MESSAGE);
        assert.ok(body.correlationId, 'correlationId must be echoed');
        assert.ok(!secretsLeaked(body), 'secret leaked into envelope');
        assert.ok(!JSON.stringify(body).includes('401'), 'upstream 401 leaked outward');
      });
    } finally {
      await app.close();
    }
  }
  await new Promise<void>((resolve) => stub401.server.close(() => resolve()));

  // --- phase 6: 403 forbidden → down + 503 neutral ----------------------------
  const stub403 = await startStubVerdaccio({ pingStatus: 403 });
  process.env.NPM_REGISTRY_URL = stub403.url;
  clearNpmAuthEnv();
  process.env.NPM_REGISTRY_USER = SECRET_USER;
  process.env.NPM_REGISTRY_PASSWORD = SECRET_PASSWORD;
  {
    const { app, base } = await boot();
    try {
      await check('403: GET /health is 200 with npmRegistry=down', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { npmRegistry?: string };
        assert.equal(body.npmRegistry, 'down');
      });

      await check('403: status is 503 neutral (no 403 outward) + Retry-After', async () => {
        const res = await fetch(`${base}/api/v1/registry/npm/status`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('retry-after'), '30');
        const body = (await readJson(res)) as {
          code?: string;
          message?: string;
          correlationId?: string;
        };
        assert.equal(body.code, 'EXTERNAL_UNAVAILABLE');
        assert.equal(body.message, NEUTRAL_MESSAGE);
        assert.ok(body.correlationId, 'correlationId must be echoed');
        assert.ok(!secretsLeaked(body), 'secret leaked into envelope');
        assert.ok(!JSON.stringify(body).includes('403'), 'upstream 403 leaked outward');
      });
    } finally {
      await app.close();
    }
  }
  await new Promise<void>((resolve) => stub403.server.close(() => resolve()));

  console.log(`\nnpm-registry e2e: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`npm-registry e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
