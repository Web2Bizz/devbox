/**
 * Domain sessions e2e (GET/POST /api/sessions, GET /api/sessions/status).
 *
 * Runs against COMPILED dist (tsc emits decorator metadata there; bun's own
 * TS transpiler does not, so this file must not run via `bun test` on TS
 * sources). Usage: `bun run build && bun dist/sessions/sessions.e2e.js`.
 *
 * Down mode (default, no Postgres, no real upstream): boots the real
 * AppModule through the shared configureApp()/setupSwagger(), patches the
 * C4 gate prototypes (organizations + workspace path, same trick as
 * opencode.e2e) and points OPENCODE_URL at a v2 stand stub that mirrors the
 * 2.2.0 shapes (provenance: contracts/opencode-stand-2.2.0.json):
 * - GET /api/session  → {data:[A,B],cursor} (A carries title+model, B none);
 * - GET /api/session/active → {data:{A:{type:'running'}}};
 * - POST /api/session  → 400 on a missing location (like the real 2.x
 *   server), echo-create otherwise; 'reject' mode answers 400 with a planted
 *   secret to prove honest EXTERNAL_BAD_REQUEST + never-echo;
 * - everything else → SPA text/html (the 2.x catch-all).
 *
 * Asserts the DOMAIN contract: our field names and values (title/model
 * nullable, ISO createdAt, directory = the jailed path, projectId = OUR uuid
 * never the runtime project hash), status DERIVED busy/idle from the active
 * map (never an empty map when the runner reports data), honest 400/404
 * error mapping without Retry-After, guest 401, PROJECT_REQUIRED, and
 * title/parentID actually forwarded to the create body (closes the mirror's
 * sdk truncation at the domain layer). A planted Basic password + upstream
 * secret must never appear in any log or response body; warn/error stay
 * one-liners (AppLogger prototype capture per opencode-keys.e2e).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// --- deterministic env (overrides repo .env AFTER bun/node dotenv load) ---
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
process.env.OPENCODE_URL = 'http://127.0.0.1:9'; // replaced with the stub once listening
process.env.OPENCODE_PASSWORD = 'e2e-basic-secret-never-log-7c1d';
process.env.DATABASE_URL = '';
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
/** Jail dir the patched WorkspacePathService returns (what directory must reach the runner). */
const JAIL_DIR = '/tmp/rush-code-e2e-project';
/** Secret planted in a rejected upstream body — must never be echoed or logged. */
const UPSTREAM_SECRET = 'e2e-upstream-secret-never-log-4b8e';

/** Upstream projectID hash — deliberately NOT a uuid: the domain row must answer OUR projectId. */
const RUNNER_PROJECT_HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const BASE_TIME = 1793000000000;
const SESSION_A = {
  id: 'ses_alpha',
  projectID: RUNNER_PROJECT_HASH,
  title: 'Alpha',
  cost: 0,
  tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: BASE_TIME, updated: BASE_TIME + 1000 },
  location: { directory: JAIL_DIR },
  model: { id: 'model-x', providerID: 'provider-y' },
};
const SESSION_B = {
  id: 'ses_beta',
  projectID: RUNNER_PROJECT_HASH,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: BASE_TIME + 2000, updated: BASE_TIME + 2000 },
  location: { directory: JAIL_DIR },
};

function startStandStub(): Promise<{
  server: Server;
  url: string;
  listDirs: string[];
  creates: Array<{ contentType: string | null; body: unknown; basicAuth: boolean }>;
  setMode: (m: 'normal' | 'reject') => void;
  close: () => Promise<void>;
}> {
  const listDirs: string[] = [];
  const creates: Array<{ contentType: string | null; body: unknown; basicAuth: boolean }> = [];
  let mode: 'normal' | 'reject' = 'normal';
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const [path] = (req.url ?? '').split('?');
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const json = (status: number, obj: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'GET' && path === '/api/session') {
          listDirs.push(query.get('directory') ?? '');
          json(200, { data: [SESSION_A, SESSION_B], cursor: { previous: null, next: null } });
          return;
        }
        if (req.method === 'GET' && path === '/api/session/active') {
          json(200, { data: { ses_alpha: { type: 'running' } } });
          return;
        }
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
            basicAuth: (req.headers.authorization ?? '').startsWith('Basic '),
          });
          if (mode === 'reject') {
            // Planted secret in the body: the domain layer must map the 400
            // to the fixed EXTERNAL_BAD_REQUEST envelope — never echo this.
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
            json(400, { _tag: 'InvalidRequestError', message: 'Expected object', kind: 'Payload' });
            return;
          }
          const title = (parsed as { title?: unknown }).title;
          json(200, {
            data: {
              id: 'ses_created',
              projectID: RUNNER_PROJECT_HASH,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: BASE_TIME + 5000, updated: BASE_TIME + 5000 },
              location: { directory: location.directory },
              ...(typeof title === 'string' ? { title } : {}),
            },
          });
          return;
        }
        // SPA catch-all, like the real 2.x server for unknown paths.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html></html>');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        listDirs,
        creates,
        setMode: (m) => {
          mode = m;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

type CheckResult = { name: string; ok: boolean; detail?: string };

async function main(): Promise<void> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { configureApp, setupSwagger } = await import('../app.setup');
  const { AppLogger } = await import('../common/app-logger.service');

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  setupSwagger(app);
  await app.listen(0);
  const base = await app.getUrl();
  const results: CheckResult[] = [];

  const { TokenService } = await import('../auth/token.service');
  const tokens = app.get(TokenService, { strict: false }) as {
    sign: (claims: Record<string, unknown>, secret: string, ttlSec: number) => { token: string };
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
  const jsonBody = (obj: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });

  // C4 gate + jail patched on the PROTOTYPES (no Postgres in this suite) so
  // requests really reach the stub (same convention as opencode.e2e).
  const { OrganizationsService } = await import('../organizations/organizations.service');
  const { WorkspacePathService } = await import('../workspaces/workspace-path.service');
  (
    OrganizationsService.prototype as unknown as { assertProjectAccessById: unknown }
  ).assertProjectAccessById = async () => ({ ownerId: E2E_USER_ID, orgIds: [] });
  const pathsProto = WorkspacePathService.prototype as unknown as Record<string, unknown>;
  pathsProto.resolveUserStrict = async () => ({ absRepo: JAIL_DIR });
  pathsProto.realStrictRoot = async () => '/tmp/rush-code-e2e-root';
  pathsProto.assertInsideJail = async (abs: string) => abs;

  const stand = await startStandStub();
  process.env.OPENCODE_URL = stand.url;

  // AppLogger capture (opencode-keys.e2e reference): fixed events only —
  // warn/error stay one-liners, planted secrets never appear anywhere.
  const logged: Array<{ method: string; text: string }> = [];
  const logMethods = ['debug', 'info', 'warn', 'error'] as const;
  const logProto = AppLogger.prototype as unknown as Record<string, (...a: unknown[]) => void>;
  const logOriginals = logMethods.map((m) => logProto[m]);
  logMethods.forEach((m, i) => {
    logProto[m] = function (...args: unknown[]) {
      logged.push({
        method: m,
        text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      });
      return (logOriginals[i] as (...a: unknown[]) => void).apply(this, args);
    };
  });

  try {
    await check('GET /api/sessions → 200 domain rows (translated, status derived)', '/api/sessions?projectId=' + E2E_PROJECT_ID, undefined, 200, (_res, body) => {
      const rows = body as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(rows) && rows.length === 2, `expected 2 rows, got ${JSON.stringify(body)?.slice(0, 120)}`);
      const a = rows[0];
      assert.equal(a.id, 'ses_alpha');
      assert.equal(a.title, 'Alpha');
      assert.equal(a.directory, JAIL_DIR);
      // Our uuid — never the runner's project hash.
      assert.equal(a.projectId, E2E_PROJECT_ID);
      assert.notEqual(a.projectId, RUNNER_PROJECT_HASH);
      assert.equal(a.createdAt, new Date(BASE_TIME).toISOString());
      assert.deepEqual(a.model, { id: 'model-x', providerID: 'provider-y' });
      assert.deepEqual(a.status, { type: 'busy' });
      const b = rows[1];
      assert.equal(b.title, null, 'title must be an explicit null, not absent');
      assert.equal(b.model, null);
      assert.deepEqual(b.status, { type: 'idle' });
    });
    assert.ok(stand.listDirs.at(-1) === JAIL_DIR, 'list must be scoped to the gated jail');

    await check('GET /api/sessions w/o projectId → 400 PROJECT_REQUIRED', '/api/sessions', undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    });

    await check('GET /api/sessions/status → derived busy/idle map (non-empty)', '/api/sessions/status?projectId=' + E2E_PROJECT_ID, undefined, 200, (_res, body) => {
      const map = body as Record<string, { type?: string }>;
      assert.deepEqual(map.ses_alpha, { type: 'busy' });
      assert.deepEqual(map.ses_beta, { type: 'idle' });
    });

    await check('POST /api/sessions forwards title/parentID + jail location', '/api/sessions', jsonBody({ projectId: E2E_PROJECT_ID, title: 'created via domain', parentID: 'ses_alpha' }), 200, (_res, body) => {
      const row = body as Record<string, unknown>;
      assert.equal(row.id, 'ses_created');
      assert.equal(row.title, 'created via domain');
      assert.equal(row.directory, JAIL_DIR);
      assert.equal(row.projectId, E2E_PROJECT_ID);
    });
    {
      const create = stand.creates.at(-1);
      assert.ok(create, 'stub captured the create');
      assert.ok((create.contentType ?? '').includes('application/json'), 'json content-type');
      assert.ok(create.basicAuth, 'Basic auth header really sent');
      const sent = create.body as { location?: { directory?: unknown }; title?: unknown; parentID?: unknown };
      assert.equal(sent.location?.directory, JAIL_DIR);
      assert.equal(sent.title, 'created via domain');
      assert.equal(sent.parentID, 'ses_alpha');
    }

    await check('POST /api/sessions {} → 400 bad_request (body zod)', '/api/sessions', jsonBody({}), 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    stand.setMode('reject');
    await check('runner 400 on create → honest 400 EXTERNAL_BAD_REQUEST (no Retry-After, no echo)', '/api/sessions', jsonBody({ projectId: E2E_PROJECT_ID, title: 'x' }), 400, (res, body) => {
      const b = body as { code?: string; message?: string };
      assert.equal(b.code, 'EXTERNAL_BAD_REQUEST');
      assert.notEqual(b.message, 'сервис временно недоступен, повторите позже');
      assert.equal(res.headers.get('Retry-After'), null);
      assert.ok(!JSON.stringify(body).includes(UPSTREAM_SECRET), 'upstream secret echoed outward');
    });
    stand.setMode('normal');

    // Real outage: network failure → 503 + Retry-After (only honest outage).
    process.env.OPENCODE_URL = 'http://127.0.0.1:9';
    await check('runner unreachable → 503 EXTERNAL_UNAVAILABLE + Retry-After', '/api/sessions?projectId=' + E2E_PROJECT_ID, undefined, 503, (res, body) => {
      assert.equal((body as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(res.headers.get('Retry-After'), '30');
    });
    process.env.OPENCODE_URL = stand.url;

    // Swagger surface: domain paths present + mirror marked deprecated.
    await check('swagger exposes /api/sessions and deprecates the mirror', '/swagger/v1.json', undefined, 200, (_res, body) => {
      const doc = body as { paths?: Record<string, Record<string, { deprecated?: boolean; tags?: string[] }>> };
      const paths = doc.paths ?? {};
      assert.ok(paths['/api/sessions'], 'missing /api/sessions in swagger');
      assert.ok(paths['/api/sessions/status'], 'missing /api/sessions/status in swagger');
      assert.ok(paths['/api/sessions']?.get?.tags?.includes('sessions'), 'sessions tag missing');
      assert.equal(paths['/api/opencode/session']?.get?.deprecated, true, 'mirror GET not deprecated');
      assert.equal(paths['/api/opencode/session']?.post?.deprecated, true, 'mirror POST not deprecated');
    });

    // Anonymous (no Bearer) → 401 before any gate/DB work — check() always
    // attaches the Bearer, so this one uses raw fetch (same pattern as opencode.e2e).
    {
      const anon = await fetch(`${base}/api/sessions?projectId=${E2E_PROJECT_ID}`);
      const anonBody = (await anon.json().catch(() => null)) as { code?: string } | null;
      try {
        assert.equal(anon.status, 401);
        assert.equal(anonBody?.code, 'unauthorized');
        results.push({ name: 'GET /api/sessions anon → 401', ok: true });
        console.log('ok   - GET /api/sessions anon → 401');
      } catch (err) {
        results.push({ name: 'GET /api/sessions anon → 401', ok: false, detail: (err as Error).message });
        console.log(`FAIL - GET /api/sessions anon → 401: ${(err as Error).message}`);
      }
    }
  } finally {
    process.env.OPENCODE_URL = 'http://127.0.0.1:9';
    await stand.close();
    logMethods.forEach((m, i) => {
      (AppLogger.prototype as unknown as Record<string, unknown>)[m] = logOriginals[i];
    });
    // Log discipline over the whole suite.
    for (const l of logged) {
      if (l.method === 'warn' || l.method === 'error') {
        assert.ok(!l.text.includes('\n'), `${l.method} line is not a one-liner: ${l.text.slice(0, 120)}`);
      }
      assert.ok(!l.text.includes(UPSTREAM_SECRET), 'upstream secret leaked into a log line');
      assert.ok(!l.text.includes(process.env.OPENCODE_PASSWORD ?? ''), 'Basic password leaked into a log line');
      assert.ok(!l.text.includes('Bearer '), 'authorization material leaked into a log line');
      assert.ok(!l.text.includes('[object Object]'), 'unserialized object in a log line');
    }
    await app.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nsessions e2e (down): ${results.length - failed.length}/${results.length} passed`);
  // Explicit exit: a cancelled socket may otherwise keep the bun loop alive.
  process.exit(failed.length > 0 ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error(`sessions e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
