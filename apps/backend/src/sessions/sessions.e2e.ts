/**
 * Domain sessions e2e (GET/POST /api/sessions, GET /api/sessions/status,
 * GET/POST /api/sessions/{id}/messages, GET /api/sessions/events).
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
 * - GET /api/info → 200 JSON (the relay's liveness probe path);
 * - GET /api/session → {data:[A,B],cursor} (A carries title+model, B none);
 * - GET /api/session/active → {data:{A:{type:'running'}}};
 * - GET /api/session/ses_alpha/message → user(text)/assistant(content[])/
 *   shell(no text) rows; any other session → honest 404 SessionNotFound
 *   with a planted secret (never echoed);
 * - GET /api/provider → {location,data:[Provider.Info rows]} with a planted
 *   secret in settings/headers (the domain projection must drop them; the
 *   jail location is captured); 'bad-provider' mode answers a row off the
 *   artifact REQUIRED set;
 * - POST /api/session/{id}/interrupt → captures the request (body must be
 *   absent), answers the artifact {interrupted:true}; any other session →
 *   honest 404 SessionNotFoundError with a planted secret;
 * - POST /api/session/{id}/prompt → captures the body, answers the
 *   Session.Inbox.User receipt; 'conflict' mode answers 409 (retryable 503
 *   through the shared mapping);
 * - GET /api/event → four SSE frames (direct data.sessionID, upstream
 *   top-level extras to drop, out-of-spec part-nesting that must NOT be
 *   hoisted, no session) then heartbeats, tracking downstream close;
 * - POST /api/session → 400 on a missing location (like the real 2.x
 *   server), echo-create otherwise; 'reject' mode answers 400 with a planted
 *   secret to prove honest EXTERNAL_BAD_REQUEST + never-echo;
 * - everything else → SPA text/html (the 2.x catch-all).
 *
 * Asserts the DOMAIN contract: our field names and values (title/model
 * nullable, ISO createdAt, directory = the jailed path, projectId = OUR uuid
 * never the runtime project hash), status DERIVED busy/idle from the active
 * map, messages text projection (null for non-text variants), prompt
 * receipt mapping + body capture (text forwarded, jail not required), SSE
 * frames {id,type,data,session?} with upstream top-level extras dropped and
 * the upstream socket really aborted on client disconnect, honest 400/404
 * error mapping without Retry-After, stranger → 404 not_found (Q3), guest
 * 401, PROJECT_REQUIRED, and title/parentID actually forwarded to the create
 * body. A planted Basic password + upstream secret must never appear in any
 * log or response body; warn/error stay one-liners (AppLogger prototype
 * capture per opencode-keys.e2e).
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
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

/** Upstream message rows for GET …/message (variants per artifact
 * Session.Message.*: user carries `text`, assistant `content[]`, shell
 * neither — the shell row must project `text: null`). */
const MESSAGE_USER = {
  id: 'msg_u1',
  type: 'user',
  time: { created: BASE_TIME + 3000 },
  text: 'Hello',
  files: [],
  agents: [],
  skills: [],
};
const MESSAGE_ASSISTANT = {
  id: 'msg_a1',
  type: 'assistant',
  time: { created: BASE_TIME + 3100 },
  agent: 'build',
  model: { id: 'model-x', providerID: 'provider-y' },
  content: [
    { type: 'text', text: 'Part one' },
    { type: 'reasoning', text: 'hidden thinking' },
    { type: 'text', text: 'Part two' },
  ],
};
const MESSAGE_SHELL = {
  id: 'msg_s1',
  type: 'shell',
  time: { created: BASE_TIME + 3200 },
  shellID: 'sh1',
  command: 'ls',
  status: 'running',
};

/** v2 SSE frames the relay must translate. */
const EVENT_FRAMES: unknown[] = [
  {
    id: 'evt_1',
    type: 'message.part.delta',
    data: { sessionID: 'ses_alpha', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'Hel' },
  },
  {
    id: 'evt_2',
    type: 'message.part.updated',
    metadata: { a: 1 },
    durable: { aggregateID: 'agg', seq: 1, version: 1 },
    location: { directory: '/tmp/somewhere' },
    data: { sessionID: 'ses_alpha', part: { id: 'prt_1', type: 'text', text: 'Hello' } },
  },
  { id: 'evt_3', type: 'x.test.nested-not-hoisted', data: { part: { sessionID: 'ses_beta' } } },
  { id: 'evt_4', type: 'x.test.no-session', data: {} },
];

type EventConn = { res: ServerResponse; timer: ReturnType<typeof setInterval> | null; closed: boolean };
type Captured = { contentType: string | null; body: unknown; basicAuth: boolean };

function parseBody(raw: string): unknown {
  try {
    return raw.length > 0 ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function startStandStub(): Promise<{
  server: Server;
  url: string;
  listDirs: string[];
  creates: Captured[];
  prompts: Array<Captured & { url: string }>;
  eventConns: EventConn[];
  interrupts: Array<Captured & { url: string }>;
  providerDirs: string[];
  setMode: (m: 'normal' | 'reject' | 'conflict' | 'bad-provider') => void;
  close: () => Promise<void>;
}> {
  const listDirs: string[] = [];
  const creates: Captured[] = [];
  const prompts: Array<Captured & { url: string }> = [];
  const eventConns: EventConn[] = [];
  const interrupts: Array<Captured & { url: string }> = [];
  const providerDirs: string[] = [];
  let mode: 'normal' | 'reject' | 'conflict' | 'bad-provider' = 'normal';
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
        if (req.method === 'GET' && path === '/api/info') {
          // The relay's liveness probe (GET /api/info) must answer JSON.
          json(200, { version: '2.2.0-e2e', pid: 1, hostname: 'stub' });
          return;
        }
        if (req.method === 'GET' && path === '/api/session') {
          listDirs.push(query.get('directory') ?? '');
          json(200, { data: [SESSION_A, SESSION_B], cursor: { previous: null, next: null } });
          return;
        }
        if (req.method === 'GET' && path === '/api/session/active') {
          json(200, { data: { ses_alpha: { type: 'running' } } });
          return;
        }
        if (req.method === 'GET' && path === '/api/session/ses_alpha/message') {
          json(200, {
            data: [MESSAGE_USER, MESSAGE_ASSISTANT, MESSAGE_SHELL],
            cursor: { previous: null, next: null },
          });
          return;
        }
        if (req.method === 'GET' && /^\/api\/session\/[^/]+\/message$/.test(path)) {
          // Honest upstream 404 (SessionNotFoundError), secret planted.
          json(404, {
            _tag: 'SessionNotFoundError',
            sessionID: path.split('/')[3],
            message: 'Session not found',
            token: UPSTREAM_SECRET,
          });
          return;
        }
        if (req.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(path)) {
          const parsed = parseBody(raw);
          prompts.push({
            contentType: req.headers['content-type'] ?? null,
            body: parsed,
            basicAuth: (req.headers.authorization ?? '').startsWith('Basic '),
            url: path,
          });
          if (mode === 'conflict') {
            // Upstream 409 surfaces through the shared mapping (retryable
            // 503 EXTERNAL_UNAVAILABLE), never echoing the planted secret.
            json(409, { _tag: 'ConflictError', message: 'busy', resource: 'session', token: UPSTREAM_SECRET });
            return;
          }
          const text = (parsed as { text?: unknown } | null)?.text;
          json(200, {
            data: {
              id: 'msg_q1',
              sessionID: 'ses_alpha',
              time: { created: BASE_TIME + 4000 },
              type: 'user',
              payload: { text: typeof text === 'string' ? text : '' },
              delivery: 'queue',
            },
          });
          return;
        }
        if (req.method === 'POST' && /^\/api\/session\/[^/]+\/interrupt$/.test(path)) {
          const parsed = parseBody(raw);
          interrupts.push({
            contentType: req.headers['content-type'] ?? null,
            body: parsed,
            basicAuth: (req.headers.authorization ?? '').startsWith('Basic '),
            url: path,
          });
          if (path === '/api/session/ses_alpha/interrupt') {
            // Artifact SessionInterruptResponse: {interrupted} (true here;
            // the stub really received the POST, proven by the capture).
            json(200, { interrupted: true });
            return;
          }
          json(404, {
            _tag: 'SessionNotFoundError',
            sessionID: path.split('/')[3],
            message: 'Session not found',
            token: UPSTREAM_SECRET,
          });
          return;
        }
        if (req.method === 'GET' && path === '/api/provider') {
          providerDirs.push(query.get('location[directory]') ?? '');
          if (mode === 'bad-provider') {
            // Row violating the artifact REQUIRED set — the domain must fail
            // loud (never skip/default a drifted row), never echo the secret.
            json(200, { location: {}, data: [{ id: 'p', name: 'P', activation: 'enabled', token: UPSTREAM_SECRET }] });
            return;
          }
          // rows carry settings/headers/body with a planted secret: the
          // domain projection must drop every non-required member.
          json(200, {
            location: {},
            data: [
              {
                id: 'prov-openai',
                name: 'OpenAI',
                activation: 'enabled',
                package: '@ai-sdk/openai',
                settings: { token: UPSTREAM_SECRET },
                headers: { authorization: UPSTREAM_SECRET },
                body: {},
              },
              {
                id: 'prov-anthropic',
                name: '',
                activation: 'auto',
                package: '',
              },
            ],
          });
          return;
        }
        if (req.method === 'GET' && path === '/api/event') {
          // SSE: emit the prepared frames spaced out, then heartbeats until
          // the client (the relay's abort on downstream close) hangs up.
          // Disconnect is tracked on the RESPONSE, not the request: under
          // the bun runtime IncomingMessage 'close' fires as soon as the
          // (empty) GET is consumed, which would stop the writes at frame 0.
          const conn: EventConn = { res, timer: null, closed: false };
          eventConns.push(conn);
          res.on('close', () => {
            conn.closed = true;
            if (conn.timer) clearInterval(conn.timer);
          });
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          let i = 0;
          const write = (): void => {
            if (conn.closed || res.writableEnded) return;
            try {
              if (i < EVENT_FRAMES.length) {
                res.write(`data: ${JSON.stringify(EVENT_FRAMES[i])}\n\n`);
                i += 1;
              } else {
                res.write(': heartbeat\n\n');
              }
            } catch {
              conn.closed = true;
            }
          };
          write();
          conn.timer = setInterval(write, 80);
          return;
        }
        if (req.method === 'POST' && path === '/api/session') {
          const parsed = parseBody(raw);
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
        prompts,
        eventConns,
        interrupts,
        providerDirs,
        setMode: (m) => {
          mode = m;
        },
        close: () =>
          new Promise<void>((done) => {
            // Kill live SSE sockets first — server.close() would otherwise
            // wait forever on the keep-open event stream.
            for (const conn of eventConns) {
              if (conn.timer) clearInterval(conn.timer);
              if (!conn.res.writableEnded) conn.res.destroy();
            }
            server.close(() => done());
          }),
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

  // C4 gate + jail patched on the PROTOTYPES (no Postgres in this suite) so
  // requests really reach the stub (same convention as opencode.e2e).
  const { OrganizationsService } = await import('../organizations/organizations.service');
  const { WorkspacePathService } = await import('../workspaces/workspace-path.service');
  const allowAccess = async (): Promise<{ ownerId: string; orgIds: string[] }> => ({
    ownerId: E2E_USER_ID,
    orgIds: [],
  });
  (
    OrganizationsService.prototype as unknown as { assertProjectAccessById: unknown }
  ).assertProjectAccessById = allowAccess;
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

    await check('POST /api/sessions forwards model (upstream Model.Ref verbatim)', '/api/sessions', jsonBody({ projectId: E2E_PROJECT_ID, model: { id: 'model-m', providerID: 'prov-openai' } }), 200, (_res, body) => {
      assert.equal((body as Record<string, unknown>).id, 'ses_created');
    });
    {
      const create = stand.creates.at(-1);
      assert.ok(create, 'stub captured the model create');
      assert.deepEqual((create.body as { model?: unknown }).model, { id: 'model-m', providerID: 'prov-openai' });
      assert.ok(create.basicAuth, 'Basic auth header really sent');
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

    // --- providers & interrupt (card 6 domain routes) ----------------------
    await check('GET /api/sessions/providers → required artifact subset only, jail location forwarded', '/api/sessions/providers?projectId=' + E2E_PROJECT_ID, undefined, 200, (_res, body) => {
      const rows = body as unknown[];
      assert.deepEqual(rows, [
        { id: 'prov-openai', name: 'OpenAI', activation: 'enabled', package: '@ai-sdk/openai' },
        { id: 'prov-anthropic', name: '', activation: 'auto', package: '' },
      ]);
      // settings/headers/body (planted secret) never leave the projection.
      assert.ok(!JSON.stringify(rows).includes(UPSTREAM_SECRET), 'provider secret echoed outward');
      assert.equal(stand.providerDirs.at(-1), JAIL_DIR, 'providers ran in the gated jail');
    });

    await check('GET providers w/o projectId → 400 PROJECT_REQUIRED', '/api/sessions/providers', undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    });

    stand.setMode('bad-provider');
    await check('provider row off the artifact REQUIRED set → fails loud (503), secret never echoed', '/api/sessions/providers?projectId=' + E2E_PROJECT_ID, undefined, 503, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
      assert.ok(!JSON.stringify(body).includes(UPSTREAM_SECRET), 'upstream secret echoed outward');
    });
    stand.setMode('normal');

    await check('POST /api/sessions/{id}/interrupt → 200 {interrupted:true} (idle no-op is honest data, never an error)', '/api/sessions/ses_alpha/interrupt', jsonBody({ projectId: E2E_PROJECT_ID }), 200, (_res, body) => {
      assert.deepEqual(body, { interrupted: true });
    });
    {
      const intr = stand.interrupts.at(-1);
      assert.ok(intr, 'stub captured the interrupt');
      assert.equal(intr.url, '/api/session/ses_alpha/interrupt');
      assert.equal(intr.body, null, 'artifact declares no body — none is sent');
      assert.ok(intr.basicAuth, 'Basic auth header really sent');
    }

    await check('POST interrupt w/o projectId → 400 bad_request (body zod)', '/api/sessions/ses_alpha/interrupt', jsonBody({}), 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    await check('POST interrupt unknown session → honest 404 EXTERNAL_NOT_FOUND (no Retry-After, no echo)', '/api/sessions/ses_ghost/interrupt', jsonBody({ projectId: E2E_PROJECT_ID }), 404, (res, body) => {
      const b = body as { code?: string };
      assert.equal(b.code, 'EXTERNAL_NOT_FOUND');
      assert.equal(res.headers.get('Retry-After'), null);
      assert.ok(!JSON.stringify(body).includes(UPSTREAM_SECRET), 'upstream secret echoed outward');
    });

    // --- messages ---------------------------------------------------------
    await check('GET /api/sessions/{id}/messages → text projection per variant', '/api/sessions/ses_alpha/messages?projectId=' + E2E_PROJECT_ID, undefined, 200, (_res, body) => {
      const rows = body as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(rows) && rows.length === 3, `expected 3 rows, got ${JSON.stringify(body)?.slice(0, 160)}`);
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
        // only the TEXT content parts joined (reasoning is not chat text)
        text: 'Part one\n\nPart two',
      });
      assert.deepEqual(rows[2], {
        id: 'msg_s1',
        type: 'shell',
        createdAt: new Date(BASE_TIME + 3200).toISOString(),
        text: null,
      });
    });

    await check('GET messages limit=abc → 400 bad_request', '/api/sessions/ses_alpha/messages?projectId=' + E2E_PROJECT_ID + '&limit=abc', undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    await check('GET messages unknown session → honest 404 EXTERNAL_NOT_FOUND (no echo)', '/api/sessions/ses_ghost/messages?projectId=' + E2E_PROJECT_ID, undefined, 404, (res, body) => {
      const b = body as { code?: string };
      assert.equal(b.code, 'EXTERNAL_NOT_FOUND');
      assert.equal(res.headers.get('Retry-After'), null);
      assert.ok(!JSON.stringify(body).includes(UPSTREAM_SECRET), 'upstream secret echoed outward');
    });

    await check('POST messages captures text + maps Inbox.User receipt', '/api/sessions/ses_alpha/messages', jsonBody({ projectId: E2E_PROJECT_ID, text: 'hi domain' }), 200, (_res, body) => {
      assert.deepEqual(body, {
        id: 'msg_q1',
        type: 'user',
        createdAt: new Date(BASE_TIME + 4000).toISOString(),
        text: 'hi domain',
      });
    });
    {
      const prompt = stand.prompts.at(-1);
      assert.ok(prompt, 'stub captured the prompt');
      assert.equal(prompt.url, '/api/session/ses_alpha/prompt');
      assert.deepEqual(prompt.body, { text: 'hi domain' });
      assert.ok((prompt.contentType ?? '').includes('application/json'), 'json content-type');
      assert.ok(prompt.basicAuth, 'Basic auth header really sent');
    }

    await check('POST messages forwards model in the prompt body (model pinned at create, not re-sent on prompt)', '/api/sessions/ses_alpha/messages', jsonBody({ projectId: E2E_PROJECT_ID, text: 'hi model', model: { id: 'model-m', providerID: 'prov-openai', variant: 'v1' } }), 200, (_res, body) => {
      assert.equal((body as Record<string, unknown>).text, 'hi model');
    });
    {
      const prompt = stand.prompts.at(-1);
      assert.ok(prompt, 'stub captured the model prompt');
      // upstream /api/session/{id}/prompt does not accept `model` (additionalProperties:false)
      // — the model is pinned at session creation time, so the prompt body is text-only.
      assert.deepEqual(prompt.body, { text: 'hi model' });
      assert.ok(prompt.basicAuth, 'Basic auth header really sent');
    }

    await check('POST messages text:"" → 400 bad_request (body zod)', '/api/sessions/ses_alpha/messages', jsonBody({ projectId: E2E_PROJECT_ID, text: '' }), 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    });

    stand.setMode('conflict');
    await check('runner 409 on prompt → 503 EXTERNAL_UNAVAILABLE + Retry-After (shared mapping, no echo)', '/api/sessions/ses_alpha/messages', jsonBody({ projectId: E2E_PROJECT_ID, text: 'busy' }), 503, (res, body) => {
      assert.equal((body as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(res.headers.get('Retry-After'), '30');
      assert.ok(!JSON.stringify(body).includes(UPSTREAM_SECRET), 'upstream secret echoed outward');
    });
    stand.setMode('normal');

    // --- SSE events -------------------------------------------------------
    {
      const ctrl = new AbortController();
      const frames: Array<Record<string, unknown>> = [];
      try {
        const res = await fetch(`${base}/api/sessions/events?projectId=${E2E_PROJECT_ID}`, {
          headers: { ...authHeaders, accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (res.body) {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          const deadline = Date.now() + 8000;
          while (frames.length < 4 && Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const line = chunk.split('\n').find((l) => l.startsWith('data:'));
              if (line) frames.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
            }
          }
        }
        try {
          assert.equal(res.status, 200);
          assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
          assert.equal(frames.length, 4, `expected 4 frames, got ${frames.length}`);
          const [f1, f2, f3, f4] = frames;
          // domain envelope: id/type/data(+session) — upstream top-level
          // extras (metadata/durable/location) dropped, no upstream names.
          assert.deepEqual(Object.keys(f1).sort(), ['data', 'id', 'session', 'type']);
          assert.equal(f1.id, 'evt_1');
          assert.equal(f1.type, 'message.part.delta');
          assert.equal(f1.session, 'ses_alpha');
          assert.deepEqual(f1.data, {
            sessionID: 'ses_alpha',
            messageID: 'msg_1',
            partID: 'prt_1',
            field: 'text',
            delta: 'Hel',
          });
          assert.deepEqual(Object.keys(f2).sort(), ['data', 'id', 'session', 'type'], 'metadata/durable/location must be dropped');
          assert.deepEqual(Object.keys(f3).sort(), ['data', 'id', 'type']);
          assert.equal(f3.session, undefined, 'out-of-spec data.part nesting must NOT be hoisted');
          assert.deepEqual(Object.keys(f4).sort(), ['data', 'id', 'type'], 'no-session frame must not carry session');
          assert.ok(!Object.keys(f1).includes('sessionID'), 'upstream name at top level');
          push('GET /api/sessions/events → domain frames (hoisted session, extras dropped)', null);
        } catch (err) {
          push('GET /api/sessions/events → domain frames (hoisted session, extras dropped)', err as Error);
        } finally {
          ctrl.abort();
        }
        // The relay aborts the upstream fetch on downstream close: the stub
        // must observe the connection closed.
        let sawClose = false;
        for (let i = 0; i < 40; i += 1) {
          if (stand.eventConns.at(-1)?.closed) {
            sawClose = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        push(
          'SSE downstream abort closes the upstream connection (relaySse reuse)',
          sawClose ? null : new Error('upstream SSE connection never saw close'),
        );
      } catch (err) {
        push('GET /api/sessions/events → domain frames (hoisted session, extras dropped)', err as Error);
      }
    }

    await check('GET /api/sessions/events w/o projectId → 400 PROJECT_REQUIRED', '/api/sessions/events', undefined, 400, (_res, body) => {
      assert.equal((body as { code?: string }).code, 'PROJECT_REQUIRED');
    });

    // --- stranger project → 404 not_found (Q3) ----------------------------
    {
      const { NotFoundException } = await import('@nestjs/common');
      (
        OrganizationsService.prototype as unknown as { assertProjectAccessById: unknown }
      ).assertProjectAccessById = async (): Promise<never> => {
        // What the real service throws for strangers (no existence leak).
        throw new NotFoundException('Project 123e4567-e89b-12d3-a456-426614174090 not found');
      };
      try {
        await check('GET /api/sessions stranger project → 404 not_found (no Retry-After)', '/api/sessions?projectId=' + E2E_PROJECT_ID, undefined, 404, (res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
          assert.equal(res.headers.get('Retry-After'), null);
        });
        await check('GET /api/sessions/{id}/messages stranger project → 404 not_found', '/api/sessions/ses_alpha/messages?projectId=' + E2E_PROJECT_ID, undefined, 404, (_res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
        });
        await check('GET providers stranger project → 404 not_found', '/api/sessions/providers?projectId=' + E2E_PROJECT_ID, undefined, 404, (_res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
        });
        await check('POST interrupt stranger project → 404 not_found', '/api/sessions/ses_alpha/interrupt', jsonBody({ projectId: E2E_PROJECT_ID }), 404, (_res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
        });
      } finally {
        (
          OrganizationsService.prototype as unknown as { assertProjectAccessById: unknown }
        ).assertProjectAccessById = allowAccess;
      }
    }

    // Real outage: network failure → 503 + Retry-After (only honest outage).
    process.env.OPENCODE_URL = 'http://127.0.0.1:9';
    await check('runner unreachable → 503 EXTERNAL_UNAVAILABLE + Retry-After', '/api/sessions?projectId=' + E2E_PROJECT_ID, undefined, 503, (res, body) => {
      assert.equal((body as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(res.headers.get('Retry-After'), '30');
    });
    await check('events unreachable → 503 JSON before any SSE header', '/api/sessions/events?projectId=' + E2E_PROJECT_ID, { headers: { accept: 'text/event-stream' } }, 503, (res, body) => {
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.equal((body as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
    });
    process.env.OPENCODE_URL = stand.url;

    // Swagger surface: domain paths present + mirror marked deprecated.
    await check('swagger exposes /api/sessions and deprecates the mirror', '/swagger/v1.json', undefined, 200, (_res, body) => {
      const doc = body as { paths?: Record<string, Record<string, { deprecated?: boolean; tags?: string[] }>> };
      const paths = doc.paths ?? {};
      assert.ok(paths['/api/sessions'], 'missing /api/sessions in swagger');
      assert.ok(paths['/api/sessions/status'], 'missing /api/sessions/status in swagger');
      assert.ok(paths['/api/sessions/{id}/messages'], 'missing /api/sessions/{id}/messages in swagger');
      assert.ok(paths['/api/sessions/events'], 'missing /api/sessions/events in swagger');
      assert.ok(paths['/api/sessions/providers'], 'missing /api/sessions/providers in swagger');
      assert.ok(paths['/api/sessions/{id}/interrupt'], 'missing /api/sessions/{id}/interrupt in swagger');
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
        push('GET /api/sessions anon → 401', null);
      } catch (err) {
        push('GET /api/sessions anon → 401', err as Error);
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
      assert.ok(!l.text.includes(stand.url), 'upstream URL leaked into a log line');
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
