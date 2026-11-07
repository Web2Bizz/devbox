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
 * Without a database the gate denies with 503 EXTERNAL_UNAVAILABLE
 * («сервис временно недоступен, повторите позже») + Retry-After; with the
 * gate/history patched the durable list is an honest 200 [] (there is no
 * external runner anymore — the embedded OpenCode host lives in-process).
 * Never logs secrets; reports db 'down' (strict Postgres) (no external
 * network).
 */
import assert from 'node:assert/strict';

// --- deterministic env (overrides repo .env AFTER bun/node dotenv load) ---
// NOTE: must run BEFORE AppModule is imported — ConfigModule.forRoot({validate})
// executes at import time. Hence the dynamic imports inside main().
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
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
// Org id the patched C4 gate reports (org-only model: directory jail needs it).
const E2E_ORG_ID = '123e4567-e89b-12d3-a456-426614174095';

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
    await check('GET /api/v1/sessions without DB → 503 + Retry-After (C4 gate)', `/api/v1/sessions?projectId=${E2E_PROJECT_ID}`, undefined, 503, (res, body) => {
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
      assert.ok(!paths.some((path) => path.startsWith('/api/opencode')), `unversioned /api/opencode survived: ${paths.join(',')}`);
      assert.ok(paths.includes('/api/v1/sessions'), `missing /api/v1/sessions in ${paths.join(',')}`);
      assert.ok(paths.includes('/api/v1/sessions/status'), `missing /api/v1/sessions/status in ${paths.join(',')}`);
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

    // --- durable list with the gate/history patched (no external runner) ----
    // The C4 project gate and workspace jail are patched on the service
    // PROTOTYPES (no Postgres in this suite); history reads are stubbed empty
    // so the durable list answers an honest 200 [] instead of a DB outage.
    const { SessionHistoryRepository } = await import(
      '../../processes/modules/ai/modules/sessions/session-history.repository'
    );
    const historyProto = SessionHistoryRepository.prototype as unknown as {
      listLocalSessions: (projectId: string) => Promise<Array<unknown>>;
      listMessages: (sessionId: string) => Promise<Array<unknown>>;
    };
    const originalListLocalSessions = historyProto.listLocalSessions;
    const originalListMessages = historyProto.listMessages;
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
      orgsProto.assertProjectAccessById = async () => ({ ownerId: E2E_USER_ID, orgIds: [E2E_ORG_ID] });
      const pathsProto = WorkspacePathService.prototype as unknown as {
        resolveOrgStrict: (
          userId: string,
          projectId: string,
          subPath?: string,
        ) => Promise<{ absRepo: string }>;
        realStrictRoot: () => Promise<string>;
        assertInsideJail: (abs: string, jailReal: string) => Promise<string>;
      };
      pathsProto.resolveOrgStrict = async () => ({ absRepo: '/tmp/rush-code-e2e-project' });
      pathsProto.realStrictRoot = async () => '/tmp/rush-code-e2e-root';
      pathsProto.assertInsideJail = async (abs: string) => abs;
      historyProto.listLocalSessions = async () => [];
      historyProto.listMessages = async () => [];

      await check(
        'GET /api/v1/sessions with durable store patched → 200 [] (no runner upstream)',
        `/api/v1/sessions?projectId=${E2E_PROJECT_ID}`,
        undefined,
        200,
        (res, body) => {
          assert.deepEqual(body, []);
          assert.equal(res.headers.get('Retry-After'), null);
        },
      );
      await check(
        'GET /api/v1/sessions/{id}/messages with durable store patched → 200 []',
        `/api/v1/sessions/123e4567-e89b-12d3-a456-426614174099/messages?projectId=${E2E_PROJECT_ID}`,
        undefined,
        200,
        (_res, body) => {
          assert.deepEqual(body, []);
        },
      );
    } finally {
      historyProto.listLocalSessions = originalListLocalSessions;
      historyProto.listMessages = originalListMessages;
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
