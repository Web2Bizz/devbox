/**
 * Opencode sdk-mirror e2e — self-contained runner (no new deps, plain fetch).
 *
 * Runs against COMPILED dist (tsc emits decorator metadata there; bun's own
 * TS transpiler does not, so this file must not be executed via `bun test`
 * on TS sources). Usage: `bun run build && bun dist/opencode/opencode.e2e.js`.
 *
 * Down mode (default): boots the real AppModule through the shared
 * configureApp()/setupSwagger() on an ephemeral port and asserts the
 * VERSION_NEUTRAL sdk mirror (/api/opencode/*, no version segment):
 * - unreachable upstream (OPENCODE_URL down) answers 503 EXTERNAL_UNAVAILABLE
 *   («сервис временно недоступен, повторите позже») with Retry-After —
 *   no mock 200s, a 200 always means live upstream data;
 * - an upstream that refuses the credentials we sent (401) answers 503
 *   EXTERNAL_UNAUTHORIZED instead — a distinct code and NO Retry-After
 *   (the C4 project gate + the workspace jail are patched in that phase so
 *   the request really reaches the upstream);
 * - a v2 stand stub phase (gate/jail patched): POST session forwards the
 *   gated project jail as the body `location.directory` (an empty body dies
 *   at the 2.x server with 400 `Expected object`), GET global/health is
 *   synthesized from GET /api/info ({healthy:true, version} — the 2.x spec
 *   has no health path), and request-level upstream failures answer honestly
 *   (400 → EXTERNAL_BAD_REQUEST, 404 → EXTERNAL_NOT_FOUND — 4xx, no
 *   Retry-After, never the 503 outage mask); AppLogger is captured for the
 *   whole phase (one-liner warn/error, planted upstream secret + Bearer
 *   material never in any line);
 * - session/message/provider routes are project-scoped (C4): every call
 *   carries ?projectId past the Bearer guard; the gate denies with the same
 *   503 envelope here (no DB in this suite); missing projectId → 400
 *   PROJECT_REQUIRED; anonymous → 401;
 * - POST prompt/command/shell validate bodies (400 envelope);
 *   GET messages validates ?limit (400 envelope);
 * - /health stays 200; swagger v1 JSON exposes the opencode tag/paths.
 * Never logs secrets; reports db 'down' (strict Postgres) (no external network).
 *
 * Live mode (opt-in): OPENCODE_LIVE_URL=http://127.0.0.1:4096 bun
 * dist/opencode/opencode.e2e.js — after the down phase, respawns itself with
 * OPENCODE_URL=<live> and asserts live 200s (create/patch/fork/status,
 * messages list with limit cursor, SSE headers, global/health version ==
 * pinned @opencode-ai/sdk version). Live session routes ALSO pass the C4
 * project gate, so live mode additionally needs a live Postgres with a
 * project the caller can access (same ?projectId) — without it the gate
 * denies before upstream is reached. LLM-dependent 200s (prompt/command/shell
 * execution) are intentionally NOT asserted — the temp server has no model
 * credentials; their 400-validation is covered in down mode.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// --- deterministic env (overrides repo .env AFTER bun/node dotenv load) ---
// NOTE: must run BEFORE AppModule is imported — ConfigModule.forRoot({validate})
// executes at import time. Hence the dynamic imports inside main().
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
const LIVE_URL = process.env.OPENCODE_LIVE_URL;
const LIVE_MODE = process.env.OPENCODE_E2E_MODE === 'live';
// Fast ECONNREFUSED → sdk-mirror 503 (no waiting on real upstream).
process.env.OPENCODE_URL = LIVE_MODE && LIVE_URL ? LIVE_URL : 'http://127.0.0.1:9';
// No database in e2e → strict Postgres reports db:down (no secrets, no sockets).
process.env.DATABASE_URL = '';
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST']) {
  delete process.env[key];
}
// Guarded mirror routes (C4) need a Bearer past JwtAuthGuard; the project
// gate itself denies with 503 here (no DB) — same EXTERNAL_UNAVAILABLE envelope.
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-not-real-0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-not-real-0123456789';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '7d';
process.env.AUTH_LEGACY_MOCK_FALLBACK = 'false';

// Project id carried on every session/provider call (C4 ?projectId). No DB
// here, so the gate denies with 503 EXTERNAL_UNAVAILABLE (never upstream).
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
 * sdk result tuple (`response.status`), not from the parsed body.
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

/** Marker secret planted in an upstream error body — must never reach logs. */
const UPSTREAM_SECRET = 'e2e-upstream-secret-never-log-9f3a';
/** Jailed dir the workspace-path prototype stub returns in this suite. */
const E2E_PROJECT_DIR = '/tmp/rush-code-e2e-project';

/**
 * Stub of the v2 stand for the location/health/4xx phase:
 * - POST /api/session mirrors the real 2.2.0 server: an empty/absent JSON
 *   body (or one without `location.directory`) → 400 `Expected object`
 *   (`Payload`), a location-carrying body → 200 `{ data: SessionV2Info }`.
 *   Every create attempt is captured (content-type + parsed body).
 * - GET /api/info → 200 JSON liveness (`{version, pid, …}` — no `healthy`).
 * - GET /api/session/ses_missing → 404 NotFoundError.
 * - everything else → SPA text/html (the real 2.x catch-all behaviour).
 * - `setMode('reject')` forces POST /api/session → 400 (regression trigger
 *   for the honest EXTERNAL_BAD_REQUEST mapping).
 */
function startV2StandStub(): Promise<{
  server: Server;
  url: string;
  paths: string[];
  creates: Array<{ contentType: string | null; body: unknown }>;
  setMode: (mode: 'normal' | 'reject') => void;
  close: () => Promise<void>;
}> {
  const paths: string[] = [];
  const creates: Array<{ contentType: string | null; body: unknown }> = [];
  let mode: 'normal' | 'reject' = 'normal';
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0];
        paths.push(path);
        const raw = Buffer.concat(chunks).toString('utf8');
        const json = (status: number, obj: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'POST' && path === '/api/session') {
          let parsed: unknown = null;
          try {
            parsed = raw.length > 0 ? (JSON.parse(raw) as unknown) : null;
          } catch {
            parsed = null;
          }
          creates.push({
            contentType: req.headers['content-type'] ?? null,
            body: parsed,
          });
          if (mode === 'reject') {
            // Body shape is fine — the upstream refuses anyway (400 surface
            // check). The planted marker value must never reach the logs.
            json(400, {
              _tag: 'InvalidRequestError',
              message: 'Expected object',
              kind: 'Payload',
              token: UPSTREAM_SECRET,
            });
            return;
          }
          const location = (parsed as { location?: { directory?: unknown } } | null)?.location;
          if (!parsed || !location || typeof location.directory !== 'string') {
            // Exactly what the live 2.2.0 server does for a stripped/empty
            // body — the pre-fix `{}` request died right here with a 400.
            json(400, { _tag: 'InvalidRequestError', message: 'Expected object', kind: 'Payload' });
            return;
          }
          json(200, {
            data: {
              id: 'ses_e2e_location',
              title: '',
              directory: location.directory,
              projectID: 'proj-e2e',
              time: { created: 1, updated: 1 },
            },
          });
          return;
        }
        if (req.method === 'GET' && path === '/api/info') {
          json(200, {
            version: '9.9.9-e2e',
            pid: 4242,
            hostname: 'opencode-stand',
            urls: ['http://127.0.0.1:0'],
            paths: {},
            capabilities: {},
          });
          return;
        }
        if (req.method === 'GET' && path === '/api/session/ses_missing') {
          json(404, { _tag: 'NotFoundError', message: 'Session not found' });
          return;
        }
        // SPA catch-all — never a liveness signal.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html></html>');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        paths,
        creates,
        setMode: (m) => {
          mode = m;
        },
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
  const results: CheckResult[] = [];

  // Bearer for the guarded mirror routes (guard passes, gate denies 503 w/o DB).
  const { TokenService } = await import('../auth/token.service');
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
    // Guarded routes need the Bearer; /health + /swagger stay bare-safe
    // (extra auth is ignored there).
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
    await check('GET /health 200 (db down, strict Postgres)', '/health', undefined, 200, (_res, body) => {
      const b = body as { status?: string; db?: string };
      assert.equal(b.status, 'ok');
      assert.equal(b.db, 'down');
    });

    if (LIVE_MODE) {
      await liveChecks(check, json, base, authHeaders);
    } else {
      await downChecks(check, json);
    }

    // Swagger surface includes the sdk mirror (opencode tag).
    await check('GET /swagger/v1.json exposes opencode mirror', '/swagger/v1.json', undefined, 200, (_res, body) => {
      const doc = body as { paths?: Record<string, Record<string, { tags?: string[]; parameters?: Array<{ name?: string; in?: string }> }>> };
      const paths = Object.keys(doc.paths ?? {});
      for (const p of [
        '/api/opencode/session',
        '/api/opencode/session/status',
        '/api/opencode/session/{id}',
        '/api/opencode/session/{id}/message',
        '/api/opencode/session/{id}/message/{messageID}',
        '/api/opencode/session/{id}/prompt_async',
        '/api/opencode/session/{id}/command',
        '/api/opencode/session/{id}/shell',
        '/api/opencode/session/{id}/fork',
        '/api/opencode/session/{id}/abort',
        '/api/opencode/config/providers',
        '/api/opencode/global/event',
        '/api/opencode/global/health',
        '/api/opencode/event',
      ]) {
        assert.ok(paths.includes(p), `missing ${p} in ${paths.join(',')}`);
      }
      // @ApiTags('opencode') lands on each operation (top-level `tags`
      // is only emitted when DocumentBuilder.addTag() is used).
      const sessionGet = doc.paths?.['/api/opencode/session']?.get;
      assert.ok(sessionGet?.tags?.includes('opencode'), `missing opencode tag on GET /api/opencode/session`);
      // PATCH exists on /session/{id}; limit/before documented on messages.
      assert.ok(doc.paths?.['/api/opencode/session/{id}']?.patch, 'missing PATCH /api/opencode/session/{id}');
      const msgParams = doc.paths?.['/api/opencode/session/{id}/message']?.get?.parameters ?? [];
      for (const name of ['limit', 'before']) {
        assert.ok(msgParams.some((p) => p.name === name && p.in === 'query'), `missing ?${name} on GET messages`);
      }
    });

    if (!LIVE_MODE) {
      // CORS preserved on mirror routes (even on 503 proxy errors).
      await check('CORS echo on /api/opencode/session (503)', `/api/opencode/session?projectId=${E2E_PROJECT_ID}`, { headers: { origin: 'http://localhost:8080' } }, 503, (res) => {
        assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8080');
      });
      // C1–C4: anonymous (no Bearer) → 401 before any gate/DB touch.
      // check() always attaches the Bearer, so this one uses raw fetch.
      {
        const anon = await fetch(`${base}/api/opencode/session?projectId=${E2E_PROJECT_ID}`);
        const anonBody = (await anon.json().catch(() => null)) as { code?: string } | null;
        try {
          assert.equal(anon.status, 401);
          assert.equal(anonBody?.code, 'unauthorized');
          results.push({ name: 'GET /api/opencode/session anon → 401', ok: true });
          console.log('ok   - GET /api/opencode/session anon → 401');
        } catch (err) {
          const detail = `${(err as Error).message} :: ${(JSON.stringify(anonBody) ?? '').slice(0, 200)}`;
          results.push({ name: 'GET /api/opencode/session anon → 401', ok: false, detail });
          console.log(`FAIL - GET /api/opencode/session anon → 401: ${detail}`);
        }
      }
      // --- upstream refuses our credentials (401) → EXTERNAL_UNAUTHORIZED ----
      // The sdk result tuple keeps the real HTTP status on `response.status`
      // (the parsed body has no status field) — the mirror must surface the
      // distinct code EXTERNAL_UNAUTHORIZED (503, no Retry-After), never the
      // masked "service is unavailable" answer.
      //
      // The C4 project gate and the workspace jail are patched on the service
      // PROTOTYPES (no Postgres in this suite) so the request really reaches
      // the upstream; the real gate denial stays asserted by
      // assertUnavailable above. The prototype (not the instance) is patched
      // because WorkspacePathService is provided by several modules — one
      // instance per module.
      const unauthorized = await startUnauthorizedUpstream();
      process.env.OPENCODE_URL = unauthorized.url;
      try {
        const { OrganizationsService } = await import('../organizations/organizations.service');
        const { WorkspacePathService } = await import('../workspaces/workspace-path.service');
        const orgsProto = OrganizationsService.prototype as unknown as {
          assertProjectAccessById: (
            projectId: string,
            userId: string,
            correlationId?: string,
          ) => Promise<{ ownerId: string | null; orgIds: string[] }>;
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

        await check(
          'GET /api/opencode/session upstream 401 → 503 EXTERNAL_UNAUTHORIZED (no Retry-After)',
          `/api/opencode/session?projectId=${E2E_PROJECT_ID}`,
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
        process.env.OPENCODE_URL = 'http://127.0.0.1:9';
        await unauthorized.close();
      }

      // --- v2 stand stub: gated session location + /api/info health ------
      // Card 1: POST /api/opencode/session must forward the GATED project
      // dir as the v2 body `location.directory` — an empty/absent body dies
      // at the live 2.2.0 server with 400 `Expected object` (and the pinned
      // sdk strips empty bodies entirely), so the stub mirrors that rule
      // and the check asserts the captured create carried the jail dir.
      // Card 2: GET global/health is synthesized from GET /api/info (the
      // 2.x spec has no health path), upstream 404/400 answer honestly as
      // EXTERNAL_NOT_FOUND / EXTERNAL_BAD_REQUEST (4xx, no Retry-After)
      // instead of the old 503 outage mask. Log discipline is scanned for
      // the whole phase (one-liner warn/error, no marker secret, no Bearer).
      const stand = await startV2StandStub();
      process.env.OPENCODE_URL = stand.url;
      const { AppLogger } = await import('../common/app-logger.service');
      const logged: Array<{ method: string; args: unknown[] }> = [];
      const logMethods = ['debug', 'info', 'warn', 'error'] as const;
      const logOriginals = logMethods.map(
        (m) => (AppLogger.prototype as unknown as Record<string, unknown>)[m],
      );
      logMethods.forEach((m, i) => {
        (
          AppLogger.prototype as unknown as Record<string, (...a: unknown[]) => void>
        )[m] = function (...args: unknown[]) {
          logged.push({ method: m, args });
          return (logOriginals[i] as (...a: unknown[]) => void).apply(this, args);
        };
      });
      try {
        // The C4 gate + workspace jail are patched on the PROTOTYPES (no
        // Postgres here) so the request really reaches the stub.
        const { OrganizationsService } = await import('../organizations/organizations.service');
        const { WorkspacePathService } = await import('../workspaces/workspace-path.service');
        (
          OrganizationsService.prototype as unknown as { assertProjectAccessById: unknown }
        ).assertProjectAccessById = async () => ({ ownerId: E2E_USER_ID, orgIds: [] });
        const pathsProto = WorkspacePathService.prototype as unknown as Record<string, unknown>;
        pathsProto.resolveUserStrict = async () => ({ absRepo: E2E_PROJECT_DIR });
        pathsProto.realStrictRoot = async () => '/tmp/rush-code-e2e-root';
        pathsProto.assertInsideJail = async (abs: string) => abs;

        await check(
          'POST /api/opencode/session forwards gated location.directory',
          `/api/opencode/session?projectId=${E2E_PROJECT_ID}`,
          json({ title: 'e2e-location' }),
          200,
          (_res, body) => {
            assert.equal((body as { id?: string }).id, 'ses_e2e_location');
          },
        );
        {
          const create = stand.creates.at(-1);
          assert.ok(create, 'stub captured the create request');
          assert.ok(
            (create.contentType ?? '').toLowerCase().includes('application/json'),
            `content-type was ${create.contentType}`,
          );
          const sent = create.body as { location?: { directory?: unknown } } | null;
          assert.equal(
            sent?.location?.directory,
            E2E_PROJECT_DIR,
            `create body must carry the gated jail as location.directory (got ${JSON.stringify(create.body)})`,
          );
        }

        await check(
          'GET /api/opencode/global/health 200 synthesized from /api/info',
          '/api/opencode/global/health',
          undefined,
          200,
          (_res, body) => {
            const b = body as { healthy?: boolean; version?: string };
            assert.equal(b.healthy, true);
            assert.equal(b.version, '9.9.9-e2e');
          },
        );
        assert.ok(stand.paths.includes('/api/info'), 'probe must hit /api/info');
        assert.ok(!stand.paths.includes('/global/health'), '/global/health probed');

        await check(
          'GET /api/opencode/session/:id upstream 404 → 404 EXTERNAL_NOT_FOUND (no Retry-After)',
          `/api/opencode/session/ses_missing?projectId=${E2E_PROJECT_ID}`,
          undefined,
          404,
          (res, body) => {
            const b = body as { code?: string; message?: string };
            assert.equal(b.code, 'EXTERNAL_NOT_FOUND');
            // NOT the masked outage answer.
            assert.notEqual(b.message, 'сервис временно недоступен, повторите позже');
            assert.equal(res.headers.get('Retry-After'), null);
          },
        );

        stand.setMode('reject');
        await check(
          'POST /api/opencode/session upstream 400 → 400 EXTERNAL_BAD_REQUEST (no Retry-After)',
          `/api/opencode/session?projectId=${E2E_PROJECT_ID}`,
          json({ title: 'e2e-reject' }),
          400,
          (res, body) => {
            const b = body as { code?: string; message?: string };
            assert.equal(b.code, 'EXTERNAL_BAD_REQUEST');
            assert.notEqual(b.message, 'сервис временно недоступен, повторите позже');
            assert.equal(res.headers.get('Retry-After'), null);
          },
        );
      } finally {
        process.env.OPENCODE_URL = 'http://127.0.0.1:9';
        await stand.close();
        logMethods.forEach((m, i) => {
          (AppLogger.prototype as unknown as Record<string, unknown>)[m] = logOriginals[i];
        });
        // Log discipline over the whole phase (opencode-keys.e2e reference):
        // warn/error stay one-liners; the planted upstream secret and any
        // Bearer/URL material never reach a captured log line.
        for (const { method, args } of logged) {
          const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
          if (method === 'warn' || method === 'error') {
            assert.ok(!text.includes('\n'), `${method} line is not a one-liner: ${text.slice(0, 120)}`);
          }
          assert.ok(!text.includes(UPSTREAM_SECRET), `upstream secret leaked into ${method} log`);
          assert.ok(!text.includes('Bearer '), `authorization material leaked into ${method} log`);
        }
        {
          const rejected = logged
            .filter((l) => l.method === 'debug')
            .map((l) => l.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
            .join('\n');
          // The cause detail rides as readable JSON (serializeCause) while
          // the secret key inside it is redacted — never `[object Object]`.
          if (rejected.includes('EXTERNAL_BAD_REQUEST')) {
            assert.ok(
              rejected.includes('InvalidRequestError'),
              'cause detail lost the upstream shape signal',
            );
            assert.ok(!rejected.includes('[object Object]'), 'cause serialized as [object Object]');
          }
        }
      }
    }
  } finally {
    await app.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nopencode e2e (${LIVE_MODE ? 'live' : 'down'}): ${results.length - failed.length}/${results.length} passed`);

  // Down phase green + live url given → respawn self against the live server.
  if (!LIVE_MODE && LIVE_URL && failed.length === 0) {
    console.log(`\nrespawning live phase against OPENCODE_LIVE_URL (value hidden)…`);
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync(process.execPath, [process.argv[1]], {
      env: { ...process.env, OPENCODE_E2E_MODE: 'live', OPENCODE_URL: LIVE_URL },
      stdio: 'inherit',
      timeout: 120000,
    });
    process.exit(child.status ?? 1);
  }
  // Explicit exit: a cancelled SSE socket may otherwise keep the loop alive
  // (bun fetch + body.cancel), hanging the runner.
  process.exit(failed.length > 0 ? 1 : 0);
}

type CheckFn = (
  name: string,
  path: string,
  init: RequestInit | undefined,
  expectedStatus: number,
  validate?: (res: Response, body: unknown) => void,
) => Promise<void>;

function assertUnavailable(body: unknown, res: Response): void {
  const b = body as { code?: string; message?: string; correlationId?: string };
  assert.equal(b.code, 'EXTERNAL_UNAVAILABLE');
  assert.equal(b.message, 'сервис временно недоступен, повторите позже');
  assert.equal(typeof b.correlationId, 'string');
  assert.equal(res.headers.get('x-correlation-id'), b.correlationId);
  assert.equal(res.headers.get('Retry-After'), '30');
}

async function downChecks(check: CheckFn, json: (obj: unknown) => RequestInit): Promise<void> {
  // Sdk mirror — every live path answers 503 when upstream is down. All
  // session/provider routes carry ?projectId (C4): the guard passes via
  // Bearer, the gate denies with the same 503 envelope (no DB here).
  const P = `projectId=${E2E_PROJECT_ID}`;
  await check('GET /api/opencode/session down → 503 + Retry-After', `/api/opencode/session?${P}`, undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('POST /api/opencode/session down → 503 + Retry-After', `/api/opencode/session?${P}`, json({ title: 'e2e' }), 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/session/status down → 503', `/api/opencode/session/status?${P}`, undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/session/:id down → 503', `/api/opencode/session/ses_nope?${P}`, undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('DELETE /api/opencode/session/:id down → 503', `/api/opencode/session/ses_nope?${P}`, { method: 'DELETE' }, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('PATCH /api/opencode/session/:id down → 503', `/api/opencode/session/ses_nope?${P}`, { ...json({ title: 'e2e' }), method: 'PATCH' }, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('POST /api/opencode/session/:id/fork down → 503', `/api/opencode/session/ses_nope/fork?${P}`, json({}), 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/session/:id/message down → 503', `/api/opencode/session/ses_nope/message?${P}`, undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/session/:id/message?limit=5 down → 503', `/api/opencode/session/ses_nope/message?limit=5&before=msg_nope&${P}`, undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  // C4: the project gate runs before in-method validation — a bad ?limit
  // without ?projectId answers 400 PROJECT_REQUIRED (fail-closed).
  await check(
    'GET /api/opencode/session/:id/message w/o projectId → 400 PROJECT_REQUIRED',
    '/api/opencode/session/ses_nope/message?limit=abc',
    undefined,
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    },
  );
  await check(
    'GET /api/opencode/session/:id/message w/o projectId → 400 PROJECT_REQUIRED (-1)',
    '/api/opencode/session/ses_nope/message?limit=-1',
    undefined,
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    },
  );
  await check('GET /api/opencode/session/:id/message/:messageID down → 503', `/api/opencode/session/ses_nope/message/msg_nope?${P}`, undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check(
    'POST /api/opencode/session/:id/message down → 503',
    `/api/opencode/session/ses_nope/message?${P}`,
    json({ parts: [{ type: 'text', text: 'hi' }] }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/message full body (model/agent/system/tools) down → 503',
    `/api/opencode/session/ses_nope/message?${P}`,
    json({
      model: { providerID: 'p', modelID: 'm' },
      agent: 'general',
      noReply: false,
      system: 'sys',
      tools: { bash: true },
      parts: [{ type: 'text', text: 'hi' }],
    }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/message {} → 400 envelope',
    `/api/opencode/session/ses_nope/message?${P}`,
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check(
    'POST /api/opencode/session/:id/prompt_async valid → 503',
    `/api/opencode/session/ses_nope/prompt_async?${P}`,
    json({ parts: [{ type: 'text', text: 'hi' }] }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/prompt_async {} → 400 envelope',
    `/api/opencode/session/ses_nope/prompt_async?${P}`,
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check(
    'POST /api/opencode/session/:id/command valid → 503',
    `/api/opencode/session/ses_nope/command?${P}`,
    json({ command: 'test', arguments: 'arg' }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/command {} → 400 envelope',
    `/api/opencode/session/ses_nope/command?${P}`,
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check(
    'POST /api/opencode/session/:id/shell valid → 503',
    `/api/opencode/session/ses_nope/shell?${P}`,
    json({ agent: 'general', command: 'echo hi' }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/shell {} → 400 envelope',
    `/api/opencode/session/ses_nope/shell?${P}`,
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check('POST /api/opencode/session/:id/abort down → 503', `/api/opencode/session/ses_nope/abort?${P}`, json({}), 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/config/providers down → 503', `/api/opencode/config/providers?${P}`, undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  // SSE subscribes BEFORE headers: down upstream → 503 JSON (never a mock stream).
  await check('GET /api/opencode/global/event down → 503', '/api/opencode/global/event', { headers: { accept: 'text/event-stream' } }, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/event down → 503', '/api/opencode/event', { headers: { accept: 'text/event-stream' } }, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/global/health down → 503', '/api/opencode/global/health', undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
}

async function liveChecks(check: CheckFn, json: (obj: unknown) => RequestInit, base: string, authHeaders: Record<string, string>): Promise<void> {
  // Live 200s through the proxy (no mocks — upstream is the real server).
  // LLM-dependent executions (prompt/command/shell runs) are intentionally
  // NOT asserted: the temp server has no model credentials.
  await check('live GET /api/opencode/global/health 200 {healthy:true, version} from /api/info', '/api/opencode/global/health', undefined, 200, (_res, body) => {
    const b = body as { healthy?: boolean; version?: string };
    assert.equal(b.healthy, true);
    // The version is the SERVER's (GET /api/info), independent of the pinned
    // @opencode-ai/sdk release — assert the type, not an equality.
    assert.equal(typeof b.version, 'string');
    assert.ok((b.version ?? '').length > 0, 'version must be a non-empty string');
  });

  let sessionId = '';
  await check('live POST /api/opencode/session 200', `/api/opencode/session?projectId=${E2E_PROJECT_ID}`, json({ title: 'e2e-live' }), 200, (_res, body) => {
    const b = body as { id?: string };
    assert.equal(typeof b.id, 'string');
    sessionId = b.id as string;
  });
  assert.ok(sessionId, 'session id captured for follow-up live checks');

  await check('live GET /api/opencode/session/status 200', `/api/opencode/session/status?projectId=${E2E_PROJECT_ID}`, undefined, 200, (_res, body) => {
    assert.equal(typeof body, 'object');
  });
  await check('live PATCH /api/opencode/session/:id 200', `/api/opencode/session/${sessionId}?projectId=${E2E_PROJECT_ID}`, { ...json({ title: 'e2e-live-renamed' }), method: 'PATCH' }, 200, (_res, body) => {
    assert.equal((body as { title?: string }).title, 'e2e-live-renamed');
  });
  await check('live GET /api/opencode/session/:id/message?limit=1 200 array', `/api/opencode/session/${sessionId}/message?limit=1&projectId=${E2E_PROJECT_ID}`, undefined, 200, (res, body) => {
    assert.ok(Array.isArray(body), `expected array, got ${JSON.stringify(body)?.slice(0, 120)}`);
    // Cursor passthrough documented; upstream currently sends none — assert
    // only the plumbing (header read must not crash the 200).
    assert.equal(typeof res.headers.get('content-type'), 'string');
  });
  await check('live POST /api/opencode/session/:id/fork 200', `/api/opencode/session/${sessionId}/fork?projectId=${E2E_PROJECT_ID}`, json({}), 200, (_res, body) => {
    assert.equal(typeof (body as { id?: string }).id, 'string');
  });
  // Upstream 404 (unknown message) surfaces honestly as 404
  // EXTERNAL_NOT_FOUND — no Retry-After (repeating the same request finds
  // the same absence), never masked as a 503 outage.
  await check('live GET unknown message → 404 EXTERNAL_NOT_FOUND', `/api/opencode/session/${sessionId}/message/msg_nope?projectId=${E2E_PROJECT_ID}`, undefined, 404, (res, body) => {
    const b = body as { code?: string; message?: string };
    assert.equal(b.code, 'EXTERNAL_NOT_FOUND');
    assert.equal(res.headers.get('Retry-After'), null);
  });
  await check(
    'live POST /api/opencode/session/:id/prompt_async {} → 400 envelope',
    `/api/opencode/session/${sessionId}/prompt_async?projectId=${E2E_PROJECT_ID}`,
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  // SSE: connect, assert live headers, then abort + cancel (no frame wait —
  // the temp server may stay silent; a 200 stream proves the live re-stream
  // path). Abort explicitly: a merely-cancelled socket can keep the bun
  // loop alive and hang the runner.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}/api/opencode/global/event`, {
      headers: { accept: 'text/event-stream', ...authHeaders },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    console.log('ok   - live GET /api/opencode/global/event SSE headers 200');
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  // Allow the aborted socket to settle before the runner exits.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

void main().catch((err: unknown) => {
  console.error(`opencode e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
