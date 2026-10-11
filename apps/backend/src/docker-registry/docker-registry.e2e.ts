/**
 * Docker-registry e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/docker-registry/docker-registry.e2e.js`
 *
 * Covers, per phase (down / skipped / up):
 * - GET /health stays 200 with the registry flag (down/skipped/up);
 * - GET /api/v1/registry/catalog answers 503 { code, message, correlationId }
 *   + Retry-After 30 when down/skipped, and 200 with live repositories when
 *   the stub registry is up (no mock 200s — 200 always means live data).
 * - the envelope never carries DOCKER_REGISTRY_* secret values.
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
process.env.DOCKER_REGISTRY_TIMEOUT_MS = '1000';
process.env.DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS = '1';
process.env.DOCKER_REGISTRY_RETRY_BASE_DELAY_MS = '0';
process.env.DOCKER_REGISTRY_RETRY_MAX_DELAY_MS = '0';
process.env.EXTERNAL_RETRY_MAX_ATTEMPTS = '1';
process.env.EXTERNAL_RETRY_BASE_DELAY_MS = '0';
process.env.EXTERNAL_RETRY_MAX_DELAY_MS = '0';

const SECRET_TOKEN = 'e2e-secret-token-xyz-never-log';

function startStubRegistry(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/v2/' || req.url === '/v2') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.url === '/v2/_catalog' || req.url?.startsWith('/v2/_catalog?')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ repositories: ['library/nginx', 'team/app'] }));
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
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../app.setup.js');

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
  process.env.DOCKER_REGISTRY_URL = 'http://127.0.0.1:9';
  process.env.DOCKER_REGISTRY_TOKEN = SECRET_TOKEN;
  {
    const { app, base } = await boot();
    try {
      await check('down: GET /health is 200 with registry=down', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { registry?: string };
        assert.equal(body.registry, 'down');
      });

      await check('down: GET /api/v1/registry/catalog is 503 + Retry-After', async () => {
        const res = await fetch(`${base}/api/v1/registry/catalog`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('retry-after'), '30');
        const body = (await readJson(res)) as {
          code?: string;
          message?: string;
          correlationId?: string;
        };
        assert.equal(body.code, 'EXTERNAL_UNAVAILABLE');
        assert.ok(body.correlationId, 'correlationId must be echoed');
        assert.ok(!JSON.stringify(body).includes(SECRET_TOKEN), 'secret leaked into envelope');
      });
    } finally {
      await app.close();
    }
  }

  // --- phase 2: skipped (URL unset) ------------------------------------------
  delete process.env.DOCKER_REGISTRY_URL;
  delete process.env.DOCKER_REGISTRY_TOKEN;
  {
    const { app, base } = await boot();
    try {
      await check('skipped: GET /health is 200 with registry=skipped', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { registry?: string };
        assert.equal(body.registry, 'skipped');
      });

      await check('skipped: GET /api/v1/registry/catalog is 503', async () => {
        const res = await fetch(`${base}/api/v1/registry/catalog`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('retry-after'), '30');
        const body = (await readJson(res)) as { code?: string };
        assert.equal(body.code, 'EXTERNAL_UNAVAILABLE');
      });
    } finally {
      await app.close();
    }
  }

  // --- phase 3: up (stub registry) -------------------------------------------
  const stub = await startStubRegistry();
  process.env.DOCKER_REGISTRY_URL = stub.url;
  {
    const { app, base } = await boot();
    try {
      await check('up: GET /health is 200 with registry=up', async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { registry?: string };
        assert.equal(body.registry, 'up');
      });

      await check('up: GET /api/v1/registry/catalog is 200 with live repos', async () => {
        const res = await fetch(`${base}/api/v1/registry/catalog`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { repositories?: unknown };
        assert.deepEqual(body.repositories, ['library/nginx', 'team/app']);
      });
    } finally {
      await app.close();
    }
  }
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));

  console.log(`\ndocker-registry e2e: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`docker-registry e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
