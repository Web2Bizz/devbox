/**
 * Domain sessions e2e (GET/POST /api/v1/sessions, GET /api/v1/sessions/status,
 * GET/POST /api/v1/sessions/{id}/messages, GET /api/v1/sessions/events).
 *
 * Runs against COMPILED dist (tsc emits decorator metadata there; bun's own
 * TS transpiler does not, so this file must not run via `bun test` on TS
 * sources). Usage: `bun run build && bun dist/processes/modules/ai/modules/sessions/__tests__/sessions.e2e.js`.
 *
 * Strict Postgres (throwaway container, like auth/organizations/keys suites):
 * list/status/messages read the durable store only. The embedded OpenCode host
 * (OpencodeHostService) is in-process — there is no external runner stub and
 * no external runner URL. Create is exercised against the real embedded host (the
 * same smoke the host spec relies on); provider/model inventories are asserted
 * for their current real answers (array, possibly empty).
 *
 * Asserts the DOMAIN contract: our field names and values (title/model
 * nullable, ISO createdAt, directory = the jailed path, projectId = OUR uuid),
 * durable-only messages, honest 400/404 error mapping without Retry-After,
 * stranger → 404 not_found (Q3), guest 401, PROJECT_REQUIRED, and
 * metadata.opencodeSessionId binding. Never logs secrets.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

// --- deterministic env (overrides repo .env AFTER bun/node dotenv load) ---
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
// DATABASE_URL is resolved inside main() from a throwaway Postgres: the
// durable session history reads/writes Postgres, so this suite is strict.
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST']) {
  delete process.env[key];
}
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-not-real-0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-not-real-0123456789';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '7d';
process.env.AUTH_LEGACY_MOCK_FALLBACK = 'false';

const E2E_PROJECT_ID = '123e4567-e89b-12d3-a456-426614174090';
const E2E_USER_ID = '123e4567-e89b-12d3-a456-426614174091';
/** Jail dir the patched WorkspacePathService returns. */
const JAIL_DIR = '/tmp/rush-code-e2e-project';
/** Durable session ids are our own uuids (project_sessions.id uuid). */
const SESSION_A = '123e4567-e89b-12d3-a456-426614174092';
const SESSION_B = '123e4567-e89b-12d3-a456-426614174093';
const UNKNOWN_SESSION = '123e4567-e89b-12d3-a456-426614174094';
/** Host session id bound to SESSION_A (metadata.opencodeSessionId). */
const HOST_SESSION_A = 'ses_e2e_alpha';

const BASE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);

type CheckResult = { name: string; ok: boolean; detail?: string };

async function main(): Promise<void> {
  // The embedded host creates sessions in a real directory (jail).
  mkdirSync(JAIL_DIR, { recursive: true });
  const { startTestDb } = await import('../../../../../../common/db/e2e-db.container');
  const testDb = await startTestDb();
  process.env.DATABASE_URL = testDb.url;
  console.log(`[sessions e2e] db mode: ${testDb.mode}`);

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../../../../../app/app.module');
  const { configureApp, setupSwagger } = await import('../../../../../../app/app.setup');
  const { AppLogger } = await import('../../../../../../common/logger');

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  setupSwagger(app);
  await app.listen(0);
  const base = await app.getUrl();
  const results: Array<CheckResult> = [];

  const { DbService } = await import('../../../../../../common/db/db.service');
  const { projects, projectSessions, sessionAgents, sessionMessages } = await import(
    '../../../../../../common/db/schema'
  );
  const dbService = app.get(DbService, { strict: false }) as InstanceType<typeof DbService>;
  const { eq } = await import('drizzle-orm');

  await dbService.client
    .insert(projects)
    .values({ id: E2E_PROJECT_ID, name: 'sessions-e2e' })
    .onConflictDoNothing({ target: projects.id });

  // Durable fixtures: two sessions of the project (A bound to the embedded
  // host, B without a binding) plus two history rows for A.
  await dbService.client.insert(projectSessions).values([
    {
      id: SESSION_A,
      projectId: E2E_PROJECT_ID,
      chatId: null,
      status: 'open',
      origin: 'harness',
      metadata: {
        title: 'Alpha',
        directory: JAIL_DIR,
        model: { id: 'model-x', providerID: 'provider-y' },
        status: { type: 'idle' },
        opencodeSessionId: HOST_SESSION_A,
      },
      createdAt: new Date(BASE_TIME),
    },
    {
      id: SESSION_B,
      projectId: E2E_PROJECT_ID,
      chatId: null,
      status: 'open',
      origin: 'harness',
      metadata: { directory: JAIL_DIR, status: { type: 'idle' } },
      createdAt: new Date(BASE_TIME + 2000),
    },
  ]);
  await dbService.client.insert(sessionAgents).values({
    sessionId: SESSION_A,
    projectId: E2E_PROJECT_ID,
    agentId: 'ask',
  });
  await dbService.client.insert(sessionMessages).values([
    {
      id: 'msg_u1',
      sessionId: SESSION_A,
      projectId: E2E_PROJECT_ID,
      userId: E2E_USER_ID,
      role: 'user',
      text: 'Hello',
      createdAt: new Date(BASE_TIME + 3000),
    },
    {
      id: 'msg_a1',
      sessionId: SESSION_A,
      projectId: E2E_PROJECT_ID,
      userId: E2E_USER_ID,
      role: 'assistant',
      text: 'Part one\n\nPart two',
      createdAt: new Date(BASE_TIME + 3100),
    },
  ]);

  const { TokenService } = await import('../../../../../../auth/token.service');
  const tokens = app.get(TokenService, { strict: false }) as {
    sign: (claims: Record<string, unknown>, secret: string, ttlSec: number) => { token: string };
  };
  const bearer = tokens.sign(
    { sub: E2E_USER_ID, email: 'probe@rush-code.local', typ: 'access' },
    process.env.JWT_ACCESS_SECRET as string,
    900,
  ).token;
  const authHeaders = { authorization: `Bearer ${bearer}` };

  async function request(
    path: string,
    init?: RequestInit,
  ): Promise<{ res: Response; body: unknown }> {
    const withAuth = {
      ...(init ?? {}),
      headers: { ...authHeaders, ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    };
    const res = await fetch(`${base}${path}`, withAuth);
    return { res, body: (await res.json().catch(() => null)) as unknown };
  }

  async function check(
    name: string,
    path: string,
    init: RequestInit | undefined,
    expectedStatus: number,
    validate?: (res: Response, body: unknown) => void,
  ): Promise<void> {
    const { res, body } = await request(path, init);
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

  function push(name: string, err: Error | null): void {
    if (err) {
      results.push({ name, ok: false, detail: err.message });
      console.log(`FAIL - ${name}: ${err.message}`);
    } else {
      results.push({ name, ok: true });
      console.log(`ok   - ${name}`);
    }
  }

  const jsonBody = (obj: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });

  // C4 gate + jail patched on the PROTOTYPES (same convention as the other
  // e2e suites) so requests reach the durable/host layers.
  const { ProjectAccessService } = await import(
    '../../../../../../organizations/modules/projects/modules/project-access/project-access.service'
  );
  const { WorkspacePathService } = await import('../../../../../../common/storage/workspace-path.service');
  const allowAccess = async (): Promise<{ ownerId: string; orgIds: Array<string> }> => ({
    ownerId: E2E_USER_ID,
    orgIds: [],
  });
  (
    ProjectAccessService.prototype as unknown as { assertProjectAccessById: unknown }
  ).assertProjectAccessById = allowAccess;
  const pathsProto = WorkspacePathService.prototype as unknown as Record<string, unknown>;
  pathsProto.resolveUserStrict = async () => ({ absRepo: JAIL_DIR });
  pathsProto.realStrictRoot = async () => '/tmp/rush-code-e2e-root';
  pathsProto.assertInsideJail = async (abs: string) => abs;

  // AppLogger capture: warn/error stay one-liners, secrets never appear.
  const logged: Array<{ method: string; text: string }> = [];
  const logMethods = ['debug', 'info', 'warn', 'error'] as const;
  const logProto = AppLogger.prototype as unknown as Record<string, (...a: Array<unknown>) => void>;
  const logOriginals = logMethods.map((m) => logProto[m]);
  logMethods.forEach((m, i) => {
    logProto[m] = function (...args: Array<unknown>) {
      logged.push({
        method: m,
        text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      });
      return (logOriginals[i] as (...a: Array<unknown>) => void).apply(this, args);
    };
  });

  try {
    // --- durable list/status/messages ---------------------------------------
    await check(
      'GET /api/v1/sessions → durable rows (titles/model nullable, our uuids)',
      `/api/v1/sessions?projectId=${E2E_PROJECT_ID}`,
      undefined,
      200,
      (_res, body) => {
        const rows = body as Array<Record<string, unknown>>;
        assert.ok(Array.isArray(rows) && rows.length === 2, `expected 2 rows, got ${JSON.stringify(body)?.slice(0, 120)}`);
        const a = rows[0];
        assert.equal(a.id, SESSION_A);
        assert.equal(a.title, 'Alpha');
        assert.equal(a.directory, JAIL_DIR);
        assert.equal(a.projectId, E2E_PROJECT_ID);
        assert.equal(a.createdAt, new Date(BASE_TIME).toISOString());
        assert.deepEqual(a.model, { id: 'model-x', providerID: 'provider-y' });
        assert.equal(a.agentId, 'ask');
        assert.deepEqual(a.status, { type: 'idle' });
        const b = rows[1];
        assert.equal(b.id, SESSION_B);
        assert.equal(b.title, null, 'title must be an explicit null, not absent');
        assert.equal(b.model, null);
        assert.equal(b.agentId, null);
        assert.deepEqual(b.status, { type: 'idle' });
      },
    );

    await check('GET /api/v1/sessions w/o projectId → 400 PROJECT_REQUIRED', '/api/v1/sessions', undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    });

    await check('GET /api/v1/sessions/status → all idle (no upstream round-trip)', `/api/v1/sessions/status?projectId=${E2E_PROJECT_ID}`, undefined, 200, (_res, body) => {
      assert.deepEqual(body, {
        [SESSION_A]: { type: 'idle' },
        [SESSION_B]: { type: 'idle' },
      });
    });

    await check('GET messages → durable thread only', `/api/v1/sessions/${SESSION_A}/messages?projectId=${E2E_PROJECT_ID}`, undefined, 200, (_res, body) => {
      const rows = body as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(rows) && rows.length === 2, `expected 2 rows, got ${JSON.stringify(body)?.slice(0, 160)}`);
      assert.deepEqual(rows[0], {
        id: 'msg_u1',
        type: 'user',
        createdAt: new Date(BASE_TIME + 3000).toISOString(),
        text: 'Hello',
      });
      assert.deepEqual(rows[1], {
        id: 'msg_a1',
        type: 'assistant',
        createdAt: new Date(BASE_TIME + 3100).toISOString(),
        text: 'Part one\n\nPart two',
      });
    });

    await check('GET messages limit=abc → 400 bad_request', `/api/v1/sessions/${SESSION_A}/messages?projectId=${E2E_PROJECT_ID}&limit=abc`, undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    await check('GET messages unknown session → 200 [] (durable store is honest)', `/api/v1/sessions/${UNKNOWN_SESSION}/messages?projectId=${E2E_PROJECT_ID}`, undefined, 200, (_res, body) => {
      assert.deepEqual(body, []);
    });

    // --- create validation --------------------------------------------------
    await check('POST /api/v1/sessions unknown agentId → honest 404 (no side effects)', '/api/v1/sessions', jsonBody({ projectId: E2E_PROJECT_ID, agentId: 'ghost' }), 404, (_res, body) => {
      const b = body as { code?: string; message?: string };
      assert.equal(b.code, 'not_found');
      assert.ok((b.message ?? '').includes("Agent 'ghost' not found"), `unexpected message: ${b.message}`);
    });

    await check('POST /api/v1/sessions {} → 400 bad_request (body zod)', '/api/v1/sessions', jsonBody({}), 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    // Create against the real embedded host: row first, host id in metadata.
    let createdId = '';
    await check('POST /api/v1/sessions → 200 + durable row bound to embedded host', '/api/v1/sessions', jsonBody({ projectId: E2E_PROJECT_ID, title: 'created via host' }), 200, (_res, body) => {
      const row = body as Record<string, unknown>;
      assert.equal(typeof row.id, 'string');
      assert.equal(row.title, 'created via host');
      assert.equal(row.directory, JAIL_DIR);
      assert.equal(row.projectId, E2E_PROJECT_ID);
      createdId = String(row.id);
    });
    if (createdId) {
      const rows = await dbService.client
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(eq(projectSessions.id, createdId));
      const meta = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
      const bound =
        typeof meta.opencodeSessionId === 'string' && meta.opencodeSessionId.length > 0;
      push(
        'created row stores metadata.opencodeSessionId (host binding)',
        bound ? null : new Error('metadata.opencodeSessionId missing'),
      );
      await check('GET list after create includes the durable row', `/api/v1/sessions?projectId=${E2E_PROJECT_ID}`, undefined, 200, (_res, body) => {
        const ids = (body as Array<{ id?: string }>).map((r) => r.id);
        assert.ok(ids.includes(createdId), 'created id missing from list');
      });
    }

    // --- message validation -------------------------------------------------
    await check('POST messages unknown agentId → honest 404 (before transport)', `/api/v1/sessions/${SESSION_A}/messages`, jsonBody({ projectId: E2E_PROJECT_ID, text: 'hi ghost', agentId: 'ghost' }), 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'not_found');
    });

    await check('POST messages text:"" → 400 bad_request (body zod)', `/api/v1/sessions/${SESSION_A}/messages`, jsonBody({ projectId: E2E_PROJECT_ID, text: '' }), 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    await check('POST messages unbound session → 404 (no silent local turn)', `/api/v1/sessions/${SESSION_B}/messages`, jsonBody({ projectId: E2E_PROJECT_ID, text: 'no host binding' }), 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'opencode_session_unbound');
    });

    // --- providers/models (current host answers) ---------------------------
    await check('GET providers w/o projectId → 400 PROJECT_REQUIRED', '/api/v1/sessions/providers', undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    });

    {
      const { res, body } = await request(`/api/v1/sessions/providers?projectId=${E2E_PROJECT_ID}`);
      push(
        'GET providers → 200 array (embedded host inventory)',
        res.status === 200 && Array.isArray(body)
          ? null
          : new Error(`status=${res.status} body=${JSON.stringify(body)?.slice(0, 160)}`),
      );
    }

    {
      const { res, body } = await request(`/api/v1/sessions/models?projectId=${E2E_PROJECT_ID}`);
      push(
        'GET models → 200 array (embedded host inventory)',
        res.status === 200 && Array.isArray(body)
          ? null
          : new Error(`status=${res.status} body=${JSON.stringify(body)?.slice(0, 160)}`),
      );
    }

    // --- interrupt ----------------------------------------------------------
    await check('POST interrupt w/o projectId → 400 bad_request (body zod)', `/api/v1/sessions/${SESSION_A}/interrupt`, jsonBody({}), 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    await check('POST interrupt unbound session → 404 (nothing to interrupt)', `/api/v1/sessions/${SESSION_B}/interrupt`, jsonBody({ projectId: E2E_PROJECT_ID }), 404, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'opencode_session_unbound');
    });

    // --- SSE events ---------------------------------------------------------
    await check('GET /api/v1/sessions/events w/o projectId → 400 PROJECT_REQUIRED', '/api/v1/sessions/events', undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    });
    {
      const ctrl = new AbortController();
      try {
        const res = await fetch(
          `${base}/api/v1/sessions/events?projectId=${E2E_PROJECT_ID}`,
          { headers: { ...authHeaders, accept: 'text/event-stream' }, signal: ctrl.signal },
        );
        const contentType = res.headers.get('content-type') ?? '';
        if (res.status === 200) {
          assert.match(contentType, /text\/event-stream/);
          push('GET events → 200 text/event-stream (embedded host bus)', null);
        } else {
          const body = (await res.json().catch(() => null)) as { code?: string } | null;
          assert.equal(res.status, 503);
          assert.equal(body?.code, 'EXTERNAL_UNAVAILABLE');
          push('GET events → honest 503 when the embedded host is unavailable', null);
        }
      } catch (err) {
        push('GET events → 200 text/event-stream (embedded host bus)', err as Error);
      } finally {
        ctrl.abort();
      }
    }

    // --- stranger project → 404 not_found (Q3) ----------------------------
    {
      const { NotFoundException } = await import('@nestjs/common');
      (
        ProjectAccessService.prototype as unknown as { assertProjectAccessById: unknown }
      ).assertProjectAccessById = async (): Promise<never> => {
        throw new NotFoundException(`Project ${E2E_PROJECT_ID} not found`);
      };
      try {
        await check('GET /api/v1/sessions stranger project → 404 not_found (no Retry-After)', `/api/v1/sessions?projectId=${E2E_PROJECT_ID}`, undefined, 404, (res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
          assert.equal(res.headers.get('Retry-After'), null);
        });
        await check('GET messages stranger project → 404 not_found', `/api/v1/sessions/${SESSION_A}/messages?projectId=${E2E_PROJECT_ID}`, undefined, 404, (_res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
        });
        await check('GET providers stranger project → 404 not_found', `/api/v1/sessions/providers?projectId=${E2E_PROJECT_ID}`, undefined, 404, (_res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
        });
        await check('POST interrupt stranger project → 404 not_found', `/api/v1/sessions/${SESSION_A}/interrupt`, jsonBody({ projectId: E2E_PROJECT_ID }), 404, (_res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
        });
      } finally {
        (
          ProjectAccessService.prototype as unknown as { assertProjectAccessById: unknown }
        ).assertProjectAccessById = allowAccess;
      }
    }

    // Swagger surface: domain paths present, unversioned mirror gone.
    await check('swagger exposes /api/v1/sessions, no unversioned /api/opencode mirror', '/swagger/v1.json', undefined, 200, (_res, body) => {
      const doc = body as { paths?: Record<string, Record<string, { tags?: Array<string> }>> };
      const paths = doc.paths ?? {};
      assert.ok(paths['/api/v1/sessions'], 'missing /api/v1/sessions in swagger');
      assert.ok(paths['/api/v1/sessions/status'], 'missing /api/v1/sessions/status in swagger');
      assert.ok(paths['/api/v1/sessions/{id}/messages'], 'missing /api/v1/sessions/{id}/messages in swagger');
      assert.ok(paths['/api/v1/sessions/events'], 'missing /api/v1/sessions/events in swagger');
      assert.ok(paths['/api/v1/sessions/providers'], 'missing /api/v1/sessions/providers in swagger');
      assert.ok(paths['/api/v1/sessions/{id}/interrupt'], 'missing /api/v1/sessions/{id}/interrupt in swagger');
      assert.ok(paths['/api/v1/sessions']?.get?.tags?.includes('sessions'), 'sessions tag missing');
      assert.ok(!paths['/api/opencode/session'], 'removed /api/opencode mirror is still documented');
    });

    // Anonymous (no Bearer) → 401 before any gate/DB work.
    {
      const anon = await fetch(`${base}/api/v1/sessions?projectId=${E2E_PROJECT_ID}`);
      const anonBody = (await anon.json().catch(() => null)) as { code?: string } | null;
      try {
        assert.equal(anon.status, 401);
        assert.equal(anonBody?.code, 'unauthorized');
        push('GET /api/v1/sessions anon → 401', null);
      } catch (err) {
        push('GET /api/v1/sessions anon → 401', err as Error);
      }
    }
  } finally {
    logMethods.forEach((m, i) => {
      (AppLogger.prototype as unknown as Record<string, unknown>)[m] = logOriginals[i];
    });
    // Log discipline over the whole suite.
    for (const l of logged) {
      if (l.method === 'warn' || l.method === 'error') {
        assert.ok(!l.text.includes('\n'), `${l.method} line is not a one-liner: ${l.text.slice(0, 120)}`);
      }
      assert.ok(!l.text.includes('Bearer '), 'authorization material leaked into a log line');
      assert.ok(!l.text.includes('[object Object]'), 'unserialized object in a log line');
    }
    await app.close();
    await testDb.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nsessions e2e (strict): ${results.length - failed.length}/${results.length} passed`);
  // Explicit exit: a cancelled socket may otherwise keep the bun loop alive.
  process.exit(failed.length > 0 ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error(`sessions e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
