/**
 * API versioning e2e — self-contained runner (no new deps, plain fetch).
 *
 * Runs against COMPILED dist (tsc emits decorator metadata there; bun's own
 * TS transpiler does not, so this file must not be executed via `bun test`
 * on TS sources). Usage: `bun run build && bun dist/app/__tests__/versioning.e2e.js`.
 *
 * Boots the real AppModule through the shared configureApp()/setupSwagger()
 * on an ephemeral port and asserts the v1 prefix, removed legacy /api/*
 * (now 404), the v2 404 contract and the versioned Swagger surface.
 * The former /api/v1/session|sessions|messages|chat proxy is gone (deleted
 * with ProxyService) — versioning coverage now rides the domain
 * /api/v1/sessions* surface (C4 project gate) plus the remaining v1 routes.
 * Unreachable runner (OPENCODE_URL down) answers 503 EXTERNAL_UNAVAILABLE
 * («сервис временно недоступен, повторите позже») with Retry-After —
 * no mock 200s. A runner that refuses the credentials we sent (401)
 * answers 503 EXTERNAL_UNAUTHORIZED instead — a distinct code and NO
 * Retry-After (the C4 project gate + the workspace jail are patched in
 * that phase so the request really reaches the runner).
 * Never logs secrets; reports db 'down' (strict Postgres) (no external
 * network).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// --- deterministic env (overrides repo .env AFTER bun/node dotenv load) ---
// NOTE: must run BEFORE AppModule is imported — ConfigModule.forRoot({validate})
// executes at import time. Hence the dynamic imports inside main().
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
// Fast ECONNREFUSED → 503 (no waiting on real runner).
process.env.OPENCODE_URL = 'http://127.0.0.1:9';
// No database in e2e → strict Postgres reports db:down (no secrets, no sockets).
process.env.DATABASE_URL = '';
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST']) {
  delete process.env[key];
}
// Project-scoped domain routes (C4) need a Bearer past the guard; the gate
// itself denies with 503 here (no DB) — same EXTERNAL_UNAVAILABLE envelope.
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-not-real-0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-not-real-0123456789';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '7d';
process.env.AUTH_LEGACY_MOCK_FALLBACK = 'false';

// Project id carried on every domain call (C4 ?projectId). No DB here, so
// the gate denies with 503 EXTERNAL_UNAVAILABLE (never reached upstream).
const E2E_PROJECT_ID = '123e4567-e89b-12d3-a456-426614174090';
// Hand-signed caller (TokenService.sign is pure, no DB — same pattern as
// the organizations unreachable-branch probe).
const E2E_USER_ID = '123e4567-e89b-12d3-a456-426614174091';

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
};

/**
 * Upstream that refuses the credentials we sent (401) — the honest auth
 * signal, never masked as "service unavailable".
 *
 * The body mirrors the opencode stand (`{"_tag":"UnauthorizedError"}`): it
 * carries NO status field, so the backend must take the real status from the
 * HTTP response (the sdk result tuple keeps it on `response.status`).
 */
function startUnauthorizedUpstream(): Promise<{
  server: Server;
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ _tag: 'UnauthorizedError', message: 'Authentication required' }),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function main(): Promise<void> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { configureApp, setupSwagger } = await import('../app.setup');

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  setupSwagger(app);
  await app.listen(0);
  const base = await app.getUrl();
  const results: Array<CheckResult> = [];

  // Bearer for the guarded domain routes (guard passes, gate denies 503 w/o DB).
  const { TokenService } = await import('../../auth/token.service');
  const tokens = app.get(TokenService, { strict: false }) as {
    sign: (
      claims: Record<string, unknown>,
      secret: string,
      ttlSec: number,
    ) => { token: string };
  };
  const bearer = tokens.sign(
    { sub: E2E_USER_ID, email: 'probe@rush-code.local', typ: 'access' },
    process.env.JWT_ACCESS_SECRET as string,
    900,
  ).token;
  const authHeaders = { authorization: `Bearer ${bearer}` };

  async function check(
    name: string,
    path: string,
    init: RequestInit | undefined,
    expectedStatus: number,
    validate?: (res: Response, body: unknown) => void,
  ): Promise<void> {
    // Guarded routes need the Bearer; /health + /swagger + legacy-404s stay bare.
    const withAuth =
      init === undefined
        ? { headers: { ...authHeaders } }
        : {
            ...init,
            headers: { ...authHeaders, ...((init.headers as Record<string, string> | undefined) ?? {}) },
          };
    const res = await fetch(`${base}${path}`, withAuth);
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
    await check('GET /api/v1/health 200 (versioned backend health)', '/api/v1/health', undefined, 200, (_res, body) => {
      assert.equal((body as { status?: string }).status, 'ok');
    });

    // Domain sessions surface (card 4 product contract): project-scoped
    // (C4) — the guard passes via Bearer, the gate denies 503 here (no DB)
    // with the same envelope the proxy used to answer.
    const assertUnavailable = (body: unknown, res: Response): void => {
      const b = body as { code?: string; message?: string; correlationId?: string };
      assert.equal(b.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(b.message, 'сервис временно недоступен, повторите позже');
      assert.equal(typeof b.correlationId, 'string');
      assert.equal(res.headers.get('x-correlation-id'), b.correlationId);
      assert.equal(res.headers.get('Retry-After'), '30');
    };
    await check('GET /api/v1/sessions down → 503 + Retry-After', `/api/v1/sessions?projectId=${E2E_PROJECT_ID}`, undefined, 503, (res, body) => {
      assertUnavailable(body, res);
    });
    await check('POST /api/v1/sessions {} → 400 bad_request (zod, before the gate)', '/api/v1/sessions', json({}), 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });
    // C4: no project context → 400 PROJECT_REQUIRED (fail-closed).
    await check('GET /api/v1/sessions w/o projectId → 400 PROJECT_REQUIRED', '/api/v1/sessions', undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    });
    // C1–C4: anonymous (no Bearer) → 401 before any gate/DB touch.
    {
      const anon = await fetch(`${base}/api/v1/sessions?projectId=${E2E_PROJECT_ID}`);
      try {
        assert.equal(anon.status, 401);
        assert.equal(((await anon.json().catch(() => null)) as { code?: string } | null)?.code, 'unauthorized');
        results.push({ name: 'GET /api/v1/sessions anon → 401', ok: true });
        console.log('ok   - GET /api/v1/sessions anon → 401');
      } catch (err) {
        const detail = (err as Error).message;
        results.push({ name: 'GET /api/v1/sessions anon → 401', ok: false, detail });
        console.log(`FAIL - GET /api/v1/sessions anon → 401: ${detail}`);
      }
    }

    // Deleted proxy aliases — removed → 404 envelope.
    await check('GET /api/v1/session → 404 not_found (proxy deleted)', '/api/v1/session', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    // Unversioned aliases are gone: sessions/runs live under /api/v1 only.
    await check('GET /api/sessions → 404 not_found (unversioned alias removed)', '/api/sessions', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('GET /api/runs → 404 not_found (unversioned alias removed)', '/api/runs', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('GET /api/v1/messages → 404 not_found (proxy deleted)', '/api/v1/messages?sessionId=s1', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('POST /api/v1/chat → 404 not_found (proxy deleted)', '/api/v1/chat', json({ message: 'hi' }), 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('GET /api/session → 404 not_found (legacy removed)', '/api/session', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('POST /api/chat → 404 not_found (legacy removed)', '/api/chat', json({ message: 'hi' }), 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });

    // reserved v2 → 404 envelope.
    await check('GET /api/v2/session → 404 not_found', '/api/v2/session', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('GET /api/v2/sessions → 404 not_found', '/api/v2/sessions', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('POST /api/v2/chat → 404 not_found', '/api/v2/chat', json({ message: 'hi' }), 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });

    // Unversioned /api/opencode/* mirror removed — never registered again.
    await check('GET /api/opencode/session → 404 not_found (unversioned mirror removed)', '/api/opencode/session', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });
    await check('GET /api/opencode/global/health → 404 not_found (unversioned mirror removed)', '/api/opencode/global/health', undefined, 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });

    // Swagger surface.
    await check('GET /swagger/v1 200 (UI)', '/swagger/v1', undefined, 200);
    await check('GET /swagger 200 (v1 back-compat)', '/swagger', undefined, 200);
    await check('GET /swagger/v2 200 (reserved stub)', '/swagger/v2', undefined, 200);
    await check('GET /swagger/v1.json exposes v1 + domain paths, no proxy', '/swagger/v1.json', undefined, 200, (_res, body) => {
      const paths = Object.keys((body as { paths?: Record<string, unknown> }).paths ?? {});
      assert.ok(!paths.includes('/api/v1/session'), `deleted proxy /api/v1/session came back: ${paths.join(',')}`);
      assert.ok(!paths.includes('/api/v1/messages'), `deleted proxy /api/v1/messages came back: ${paths.join(',')}`);
      assert.ok(!paths.includes('/api/v1/chat'), `deleted proxy /api/v1/chat came back: ${paths.join(',')}`);
      assert.ok(paths.includes('/api/v1/health'), `missing /api/v1/health in ${paths.join(',')}`);
      assert.ok(!paths.includes('/api/session'), `legacy /api/session must be gone, got ${paths.join(',')}`);
      // Unversioned /api/opencode/* mirror is removed: no such path may be
      // documented (the removed proxy paths above must stay gone too).
      assert.ok(!paths.some((path) => path.startsWith('/api/opencode')), `unversioned /api/opencode survived: ${paths.join(',')}`);
      assert.ok(paths.includes('/api/v1/sessions'), `missing /api/v1/sessions in ${paths.join(',')}`);
      assert.ok(paths.includes('/api/v1/sessions/status'), `missing /api/v1/sessions/status in ${paths.join(',')}`);
      // Unversioned domain aliases must not be documented: sessions/runs are
      // URI-versioned v1 only (VERSION_NEUTRAL stays reserved for /health).
      assert.ok(
        !paths.some((path) => path === '/api/sessions' || path.startsWith('/api/sessions/')),
        `unversioned /api/sessions survived: ${paths.join(',')}`,
      );
      assert.ok(
        !paths.some((path) => path === '/api/runs' || path.startsWith('/api/runs/')),
        `unversioned /api/runs survived: ${paths.join(',')}`,
      );
      // Dropping the redundant per-handler `@Version('1')` must not drop the
      // version segment from documented paths — `defaultVersion: '1'` (URI
      // versioning) is the only thing that puts /v1 into these routes.
      assert.ok(paths.includes('/api/v1/projects'), `missing /api/v1/projects in ${paths.join(',')}`);
      assert.ok(paths.includes('/api/v1/organizations'), `missing /api/v1/organizations in ${paths.join(',')}`);
      assert.ok(paths.includes('/api/v1/agents'), `missing /api/v1/agents in ${paths.join(',')}`);
    });
    await check('GET /swagger/v2.json has empty paths', '/swagger/v2.json', undefined, 200, (_res, body) => {
      assert.deepEqual((body as { paths?: unknown }).paths, {});
    });

    // CORS preserved on versioned routes (even on 503 domain errors).
    await check('CORS echo on /api/v1/sessions (503)', `/api/v1/sessions?projectId=${E2E_PROJECT_ID}`, { headers: { origin: 'http://localhost:8080' } }, 503, (res) => {
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    });

    // --- runner refuses our credentials (401) → EXTERNAL_UNAUTHORIZED ------
    // The runner answered 401/403: that is NOT "the service is
    // unavailable" — it is a distinct code (EXTERNAL_UNAUTHORIZED), answered
    // with 503 (never 401: the frontend reads any 401 as "our session
    // expired" → refresh → logout) and WITHOUT Retry-After (a retry with
    // the same credentials cannot help).
    //
    // The C4 project gate and the workspace jail are patched on the service
    // PROTOTYPES (no Postgres in this suite) so the request really reaches
    // the runner; the real gate denial stays asserted above
    // (assertUnavailable) and the "down" contract is untouched. The
    // prototype (not the instance) is patched because WorkspacePathService is
    // provided by several modules — one instance per module.
    const unauthorized = await startUnauthorizedUpstream();
    process.env.OPENCODE_URL = unauthorized.url;
    const { SessionHistoryRepository } = await import(
      '../../processes/modules/ai/modules/sessions/session-history.repository'
    );
    const historyProto = SessionHistoryRepository.prototype as unknown as {
      listLocalSessions: (projectId: string) => Promise<Array<unknown>>;
    };
    const originalListLocalSessions = historyProto.listLocalSessions;
    try {
      const { ProjectAccessService } = await import('../../organizations/modules/projects/modules/project-access/project-access.service');
      const { WorkspacePathService } = await import('../../common/storage/workspace-path.service');
      const orgsProto = ProjectAccessService.prototype as unknown as {
        assertProjectAccessById: (
          projectId: string,
          userId: string,
          correlationId?: string,
        ) => Promise<{ ownerId: string | null; orgIds: Array<string> }>;
      };
      orgsProto.assertProjectAccessById = async () => ({ ownerId: E2E_USER_ID, orgIds: [] });
      const pathsProto = WorkspacePathService.prototype as unknown as {
        resolveUserStrict: (
          userId: string,
          projectId: string,
          subPath?: string,
        ) => Promise<{ absRepo: string }>;
        realStrictRoot: () => Promise<string>;
        assertInsideJail: (abs: string, jailReal: string) => Promise<string>;
      };
      pathsProto.resolveUserStrict = async () => ({ absRepo: '/tmp/rush-code-e2e-project' });
      pathsProto.realStrictRoot = async () => '/tmp/rush-code-e2e-root';
      pathsProto.assertInsideJail = async (abs: string) => abs;
      // No Postgres in this suite (DATABASE_URL=''): the local history lookup
      // would fail with a DB-unavailable error before the runner is contacted.
      // Stub it so the request really reaches the unauthorized runner.
      historyProto.listLocalSessions = async () => [];

      await check(
        'GET /api/v1/sessions runner 401 → 503 EXTERNAL_UNAUTHORIZED (no Retry-After)',
        `/api/v1/sessions?projectId=${E2E_PROJECT_ID}`,
        undefined,
        503,
        (res, body) => {
          const b = body as { code?: string; message?: string; correlationId?: string };
          assert.equal(b.code, 'EXTERNAL_UNAUTHORIZED');
          // NOT the masked "service is unavailable" answer.
          assert.notEqual(b.message, 'сервис временно недоступен, повторите позже');
          assert.equal(typeof b.correlationId, 'string');
          assert.equal(res.headers.get('x-correlation-id'), b.correlationId);
          // No Retry-After: repeating the request cannot fix the credentials.
          assert.equal(res.headers.get('Retry-After'), null);
        },
      );
    } finally {
      historyProto.listLocalSessions = originalListLocalSessions;
      process.env.OPENCODE_URL = 'http://127.0.0.1:9';
      await unauthorized.close();
    }
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
