/**
 * API versioning e2e — self-contained runner (no new deps, plain fetch).
 *
 * Runs against COMPILED dist (tsc emits decorator metadata there; bun's own
 * TS transpiler does not, so this file must not be executed via `bun test`
 * on TS sources). Usage: `bun run build && bun dist/api/versioning.e2e.js`.
 *
 * Boots the real AppModule through the shared configureApp()/setupSwagger()
 * on an ephemeral port and asserts the v1 prefix, removed legacy /api/*
 * (now 404), the v2 404 contract and the versioned Swagger surface.
 * Unreachable upstream (OPENCODE_URL down) answers 503 EXTERNAL_UNAVAILABLE
 * («сервис временно недоступен, повторите позже») with Retry-After —
 * no mock 200s. Never logs secrets; reports db 'down' (strict Postgres) (no external
 * network).
 */
import assert from 'node:assert/strict';

// --- deterministic env (overrides repo .env AFTER bun/node dotenv load) ---
// NOTE: must run BEFORE AppModule is imported — ConfigModule.forRoot({validate})
// executes at import time. Hence the dynamic imports inside main().
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
// Fast ECONNREFUSED → proxy 503 (no waiting on real upstream).
process.env.OPENCODE_URL = 'http://127.0.0.1:9';
// No database in e2e → strict Postgres reports db:down (no secrets, no sockets).
process.env.DATABASE_URL = '';
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST']) {
  delete process.env[key];
}

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
};

async function main(): Promise<void> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { configureApp, setupSwagger } = await import('../app.setup');

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  setupSwagger(app);
  await app.listen(0);
  const base = await app.getUrl();
  const results: CheckResult[] = [];

  async function check(
    name: string,
    path: string,
    init: RequestInit | undefined,
    expectedStatus: number,
    validate?: (res: Response, body: unknown) => void,
  ): Promise<void> {
    const res = await fetch(`${base}${path}`, init);
    const body = (await res.json().catch(() => null)) as unknown;
    try {
      assert.equal(res.status, expectedStatus, `status ${res.status} !== ${expectedStatus}`);
      validate?.(res, body);
      results.push({ name, ok: true });
      console.log(`ok   - ${name}`);
    } catch (err) {
      const detail = `${(err as Error).message} :: ${(JSON.stringify(body) ?? '').slice(0, 200)}`;
      results.push({ name, ok: false, detail });
      console.log(`FAIL - ${name}: ${detail} [${init?.method ?? 'GET'} ${path}]`);
    }
  }

  const json = (obj: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });

  try {
    // /health stays unversioned at the root.
    await check('GET /health 200 (db down, strict Postgres)', '/health', undefined, 200, (_res, body) => {
      const b = body as { status?: string; db?: string };
      assert.equal(b.status, 'ok');
      assert.equal(b.db, 'down');
    });

    // v1 canonical (proxy live paths; upstream down → 503 envelope).
    const assertUnavailable = (body: unknown, res: Response): void => {
      const b = body as { code?: string; message?: string; correlationId?: string };
      assert.equal(b.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(b.message, 'сервис временно недоступен, повторите позже');
      assert.equal(typeof b.correlationId, 'string');
      assert.equal(res.headers.get('x-correlation-id'), b.correlationId);
      assert.equal(res.headers.get('Retry-After'), '30');
    };
    await check('GET /api/v1/session down → 503 + Retry-After', '/api/v1/session', undefined, 503, (res, body) => {
      assertUnavailable(body, res);
    });
    await check('GET /api/v1/messages down → 503 + Retry-After', '/api/v1/messages?sessionId=s1', undefined, 503, (res, body) => {
      assertUnavailable(body, res);
    });
    await check('POST /api/v1/chat down → 503 + Retry-After', '/api/v1/chat', json({ message: 'hi' }), 503, (res, body) => {
      assertUnavailable(body, res);
    });
    await check('POST /api/v1/chat {} → 400 envelope', '/api/v1/chat', json({}), 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    // legacy unversioned aliases — removed → 404 envelope.
    await check('GET /api/session → 404 not_found (legacy removed)', '/api/session', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('GET /api/messages → 404 not_found (legacy removed)', '/api/messages?sessionId=s1', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('POST /api/chat → 404 not_found (legacy removed)', '/api/chat', json({ message: 'hi' }), 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });

    // reserved v2 → 404 envelope.
    await check('GET /api/v2/session → 404 not_found', '/api/v2/session', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('POST /api/v2/chat → 404 not_found', '/api/v2/chat', json({ message: 'hi' }), 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });

    // Swagger surface.
    await check('GET /swagger/v1 200 (UI)', '/swagger/v1', undefined, 200);
    await check('GET /swagger 200 (v1 back-compat)', '/swagger', undefined, 200);
    await check('GET /swagger/v2 200 (reserved stub)', '/swagger/v2', undefined, 200);
    await check('GET /swagger/v1.json exposes only v1 paths', '/swagger/v1.json', undefined, 200, (_res, body) => {
      const paths = Object.keys((body as { paths?: Record<string, unknown> }).paths ?? {});
      assert.ok(paths.includes('/api/v1/session'), `missing /api/v1/session in ${paths.join(',')}`);
      assert.ok(!paths.includes('/api/session'), `legacy /api/session must be gone, got ${paths.join(',')}`);
    });
    await check('GET /swagger/v2.json has empty paths', '/swagger/v2.json', undefined, 200, (_res, body) => {
      assert.deepEqual((body as { paths?: unknown }).paths, {});
    });

    // CORS preserved on versioned routes (even on 503 proxy errors).
    await check('CORS echo on /api/v1/session (503)', '/api/v1/session', { headers: { origin: 'http://localhost:8080' } }, 503, (res) => {
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    });
  } finally {
    await app.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nversioning e2e: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`versioning e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
