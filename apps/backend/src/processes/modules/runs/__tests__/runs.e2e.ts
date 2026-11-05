/**
 * Runs e2e — /api/runs* (create → GET → live SSE journal → terminal state)
 * against COMPILED dist and a throwaway Postgres.
 *
 * Runs against COMPILED dist (tsc/swc emits decorator metadata there; bun's
 * own TS transpiler does not, so this file must not run via `bun test` on TS
 * sources). Usage: `bun run build && bun dist/processes/modules/runs/__tests__/runs.e2e.js`.
 *
 * Strict Postgres (throwaway container, like auth/organizations/keys suites):
 * run_runs/run_steps/run_events/run_leases are durable and the in-process
 * claim loop publishes every step through pg_notify. The suite boots the real
 * AppModule through the shared configureApp()/setupSwagger(), patches the C4
 * gate + jail prototypes (same trick as sessions.e2e), and points REPOS_ROOT
 * at a real git repository under /tmp so the runner can materialize the run
 * worktree, run native:git.recon and write the trailered run commit.
 *
 * The live scenario is the prototype engine end to end:
 * - POST /api/runs answers 201 RunInfo (open, branch agent/<id>, worktree
 *   inside the jail, baseCommit = the repo HEAD);
 * - the claim loop advances llm.call → tool.call (native:git.recon) →
 *   sandbox.exec (opencode runner stub) → git.commit, and
 *   GET /api/runs/:id/events?cursor=0 replays/tails the journal:
 *   run.started first, then the four run.step.committed frames
 *   (tool request/response hashes 64-hex, attempt 1; sandbox session id +
 *   command; git sha 40-hex on agent/<id> from baseCommit);
 * - a second catch-up replays the same committed seqs (no loss) and a cursor
 *   at the last delivered id tails nothing (empty), so replay is
 *   append-only-correct;
 * - the run parks at awaiting_human, the branch/worktree/commit exist on
 *   disk, the Run-Id trailer matches the journaled sha and baseCommit stays
 *   an ancestor (Forward-Only);
 * - C4 stranger → 404 (JSON, not SSE), guest → 401, bad body/id/cursor →
 *   400, unknown run → 404;
 * - `E2E_DB_MODE=unreachable` boots the same app against a dead port and
 *   asserts the honest 503 EXTERNAL_UNAVAILABLE + Retry-After 30 surface
 *   (POST and GET, never a fake 404).
 *
 * warn/error stay one-liners and no Bearer/[object Object] ever reaches a
 * log line (AppLogger prototype capture per keys.e2e); the opencode Basic
 * password never appears in a log line either.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// --- deterministic env (overrides repo .env AFTER bun/node dotenv load) ---
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
// The sandbox step dials the opencode runner (SandboxProvider). The URL is
// re-pointed at the in-process stub inside main(), before NestFactory.create;
// this dead port is only the pre-stub placeholder.
process.env.OPENCODE_URL = 'http://127.0.0.1:9';
// Basic password the sandbox stub asserts on the wire; must never reach a log.
process.env.OPENCODE_PASSWORD = 'e2e-basic-secret-never-log-runs';
// DATABASE_URL is resolved inside main() from a throwaway Postgres: the run
// journal/lease tables are durable, so this suite is strict.
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST']) {
  delete process.env[key];
}
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-not-real-0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-not-real-0123456789';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '7d';
process.env.AUTH_LEGACY_MOCK_FALLBACK = 'false';

/** Throwaway jail root (REPOS_ROOT). Must exist BEFORE AppModule import (env reads it). */
const E2E_ROOT = '/tmp/rush-code-e2e-runs';
/** The project's content repo the patched resolver returns (real git repo). */
const JAIL_DIR = `${E2E_ROOT}/content`;

// Create the root before boot: validateEnv() fail-fasts on an unreadable
// REPOS_ROOT, and a stale run from a previous attempt must not leak in.
rmSync(E2E_ROOT, { recursive: true, force: true });
mkdirSync(E2E_ROOT, { recursive: true });
process.env.REPOS_ROOT = E2E_ROOT;

const E2E_PROJECT_ID = '123e4567-e89b-12d3-a456-4266141740a0';
const E2E_USER_ID = '123e4567-e89b-12d3-a456-4266141740a1';

type CheckResult = { name: string; ok: boolean; detail?: string };
type JsonRecord = Record<string, unknown>;

type Collected = {
  status: number;
  contentType: string | null;
  frames: Array<JsonRecord>;
};

/** `data.step.seq` of a journal frame (run.step.started / committed / failed). */
function frameStepSeq(frame: JsonRecord): number {
  const data = frame.data as JsonRecord | undefined;
  const step = data?.step as JsonRecord | undefined;
  return typeof step?.seq === 'number' ? step.seq : -1;
}

/**
 * Reads an SSE route (or any JSON answer) and returns the frames parsed from
 * `data:` lines. The read always stops: on `until(frame)` it aborts the
 * downstream request, and the timeout aborts it too — in both cases the
 * accumulated frames are returned instead of throwing (a quiet live stream
 * must not hang the suite). AbortError is the normal stop signal.
 */
async function collectFrames(
  base: string,
  path: string,
  headers: Record<string, string>,
  until: (frame: JsonRecord) => boolean,
  timeoutMs: number,
): Promise<Collected> {
  const ctrl = new AbortController();
  const frames: Array<JsonRecord> = [];
  let status = 0;
  let contentType: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const consume = async (): Promise<void> => {
    const res = await fetch(`${base}${path}`, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: ctrl.signal,
    });
    status = res.status;
    contentType = res.headers.get('content-type');
    const body = res.body;
    if (!body) {
      await res.text().catch(() => undefined);
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = (await reader.read()) as unknown as { value?: Uint8Array; done: boolean };
        if (chunk.done) break;
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              frames.push(JSON.parse(line.slice(5).trim()) as JsonRecord);
            } catch {
              // Non-JSON data line — ignore; heartbeats are comments, not data.
            }
          }
        }
        if (frames.some(until)) return;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };

  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), Math.max(1, timeoutMs));
  });

  try {
    await Promise.race([consume(), deadline]);
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'AbortError') throw err;
  } finally {
    if (timer) clearTimeout(timer);
    ctrl.abort();
  }
  return { status, contentType, frames };
}

/** Trimmed stdout of one git command in `cwd` (fixture/asserts only). */
function git(cwd: string, args: Array<string>): string {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8' })).trim();
}

type SandboxStubRequest = {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
};

type SandboxStub = {
  url: string;
  requests: Array<SandboxStubRequest>;
  close: () => Promise<void>;
};

/**
 * Minimal opencode-runner stand for the sandbox step (node:http, no deps).
 *
 * Serves exactly the three routes SandboxProvider uses — POST /api/session,
 * POST /api/session/:id/shell, GET /api/info — and captures method/path/
 * authorization/body so the suite can assert the Basic header and the shell
 * command actually left the backend. Anything else is an honest 404.
 */
async function startSandboxStub(): Promise<SandboxStub> {
  const requests: Array<SandboxStubRequest> = [];
  const server = createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as unknown) : null;
      } catch {
        body = raw;
      }
      const path = req.url ?? '';
      requests.push({
        method: req.method ?? '',
        path,
        authorization: req.headers.authorization ?? null,
        body,
      });
      const send = (status: number, payload: unknown): void => {
        // `connection: close` keeps keep-alive sockets from delaying close().
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && path === '/api/session') {
        send(200, { data: { id: 'ses_runs_e2e' } });
        return;
      }
      if (req.method === 'POST' && path === '/api/session/ses_runs_e2e/shell') {
        send(200, { data: { output: 'run-ready' } });
        return;
      }
      if (req.method === 'GET' && path === '/api/info') {
        send(200, { version: '2.2.0-e2e' });
        return;
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  const port = address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function main(): Promise<void> {
  // Strict Postgres: the run registry/journal/leases and the claim loop are
  // durable, so the suite needs a live DB (one-time container by default,
  // TEST_DATABASE_URL override).
  const { startTestDb } = await import('../../../../common/db/e2e-db.container');
  const testDb = await startTestDb();
  process.env.DATABASE_URL = testDb.url;
  console.log(`[runs e2e] db mode: ${testDb.mode}`);

  // Real git repository the runner branches the worktree from. main is the
  // Forward-Only base; the claim loop commits onto agent/<run_id>.
  rmSync(JAIL_DIR, { recursive: true, force: true });
  mkdirSync(JAIL_DIR, { recursive: true });
  git(JAIL_DIR, ['init', '-b', 'main']);
  git(JAIL_DIR, [
    '-c',
    'user.email=runs-e2e@rush-code.local',
    '-c',
    'user.name=Rush Code Runs E2E',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  ]);
  const baseHead = git(JAIL_DIR, ['rev-parse', 'HEAD']);

  // opencode-runner stub for sandbox.exec: OPENCODE_URL must point at it
  // BEFORE NestFactory.create so every provider sees the live stub.
  const sandbox = await startSandboxStub();
  process.env.OPENCODE_URL = sandbox.url;

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../../../app/app.module');
  const { configureApp, setupSwagger } = await import('../../../../app/app.setup');
  const { AppLogger } = await import('../../../../common/logger');

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  setupSwagger(app);
  await app.listen(0);
  const base = await app.getUrl();
  const results: Array<CheckResult> = [];

  // run_runs carries a real FK to projects; the C4 gate is patched below, so
  // the project row only exists in this seed.
  if (testDb.mode === 'live') {
    const { DbService } = await import('../../../../common/db/db.service');
    const { projects } = await import('../../../../common/db/schema');
    const dbService = app.get(DbService, { strict: false }) as InstanceType<typeof DbService>;
    await dbService.client
      .insert(projects)
      .values({ id: E2E_PROJECT_ID, name: 'runs-e2e', ownerId: E2E_USER_ID })
      .onConflictDoNothing({ target: projects.id });
  }

  const { TokenService } = await import('../../../../auth/token.service');
  const tokens = app.get(TokenService, { strict: false }) as {
    sign: (claims: Record<string, unknown>, secret: string, ttlSec: number) => { token: string };
  };
  const bearer = tokens.sign(
    { sub: E2E_USER_ID, email: 'runs-probe@rush-code.local', typ: 'access' },
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

  // C4 gate + jail patched on the PROTOTYPES (same convention as
  // sessions.e2e): the real project row does not exist, but the claim loop
  // and the HTTP surface must still reach the real repo under the throwaway
  // root. RunWorktreeService uses its own WorkspacePathService instance —
  // the prototype patch covers both.
  const { ProjectAccessService } = await import(
    '../../../../organizations/modules/projects/modules/project-access/project-access.service'
  );
  const { WorkspacePathService } = await import(
    '../../../../common/storage/workspace-path.service'
  );
  const allowAccess = async (): Promise<{ ownerId: string; orgIds: Array<string> }> => ({
    ownerId: E2E_USER_ID,
    orgIds: [],
  });
  (
    ProjectAccessService.prototype as unknown as { assertProjectAccessById: unknown }
  ).assertProjectAccessById = allowAccess;
  const pathsProto = WorkspacePathService.prototype as unknown as Record<string, unknown>;
  const originalResolveUserStrict = pathsProto.resolveUserStrict;
  const originalRealStrictRoot = pathsProto.realStrictRoot;
  const originalAssertInsideJail = pathsProto.assertInsideJail;
  pathsProto.resolveUserStrict = async () => ({ absRepo: JAIL_DIR });
  pathsProto.realStrictRoot = async () => E2E_ROOT;
  pathsProto.assertInsideJail = async (abs: string) => abs;

  // AppLogger capture (keys.e2e reference): warn/error stay one-liners and no
  // authorization material or unserialized object ever reaches a log line.
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
    if (testDb.mode === 'unreachable') {
      // Explicit outage surface (E2E_DB_MODE=unreachable): the claim loop and
      // every route hit a dead port, so the honest answer is 503 — never a
      // fake 404 or a silent empty result.
      await check(
        'POST /api/runs unreachable db → 503 EXTERNAL_UNAVAILABLE + Retry-After',
        '/api/runs',
        jsonBody({ projectId: E2E_PROJECT_ID }),
        503,
        (res, body) => {
          assert.equal((body as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
          assert.equal(res.headers.get('Retry-After'), '30');
        },
      );
      await check(
        'GET /api/runs/{id} unreachable db → 503 (not 404)',
        `/api/runs/${randomUUID()}`,
        undefined,
        503,
        (_res, body) => {
          assert.equal((body as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
        },
      );
    } else {
      // --- create + read -------------------------------------------------
      let created: JsonRecord = {};
      await check(
        'POST /api/runs → 201 open run pinned to the repo HEAD',
        '/api/runs',
        jsonBody({ projectId: E2E_PROJECT_ID }),
        201,
        (_res, body) => {
          const run = (body ?? {}) as JsonRecord;
          created = run;
          assert.match(String(run.id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
          assert.equal(run.branch, `agent/${String(run.id)}`);
          assert.equal(typeof run.worktree, 'string');
          assert.ok(
            String(run.worktree).startsWith(JAIL_DIR),
            `worktree escaped the jail: ${String(run.worktree)}`,
          );
          assert.equal(run.baseCommit, baseHead, 'baseCommit must be the repo HEAD');
          assert.equal(run.status, 'open');
          assert.ok(
            typeof run.definitionSetHash === 'string' && run.definitionSetHash.length > 0,
            'definitionSetHash must be pinned',
          );
          assert.equal(run.title, null);
          assert.equal(run.sandboxId, null);
          assert.equal(run.agentId, null);
          assert.equal(run.model, null);
        },
      );
      const runId = String(created.id ?? '');
      const branch = String(created.branch ?? '');
      const worktree = String(created.worktree ?? '');

      await check(
        'GET /api/runs/{id} → same id/branch/baseCommit',
        `/api/runs/${runId}`,
        undefined,
        200,
        (_res, body) => {
          const run = body as JsonRecord;
          assert.equal(run.id, runId);
          assert.equal(run.branch, branch);
          assert.equal(run.baseCommit, baseHead);
          assert.equal(run.projectId, E2E_PROJECT_ID);
        },
      );

      // --- live SSE journal ---------------------------------------------
      // Stop exactly when git.commit (seq 4) commits: it is the last journal
      // event of the prototype plan, so the replay assertions below have a
      // closed, final journal to compare against.
      const fourStepsCommitted = (frame: JsonRecord): boolean =>
        frame.type === 'run.step.committed' && frameStepSeq(frame) === 4;

      let liveFrames: Array<JsonRecord> = [];
      try {
        const collected = await collectFrames(
          base,
          `/api/runs/${runId}/events?cursor=0`,
          authHeaders,
          fourStepsCommitted,
          120_000,
        );
        liveFrames = collected.frames;
        assert.equal(collected.status, 200);
        assert.match(collected.contentType ?? '', /text\/event-stream/);
        assert.ok(liveFrames.length >= 5, `expected frames, got ${liveFrames.length}`);
      } catch (err) {
        push('GET /api/runs/{id}/events → live run journal', err as Error);
      }

      try {
        const first = liveFrames[0];
        assert.ok(first, 'stream answered no frames');
        assert.equal(first.id, '1');
        assert.equal(first.type, 'run.started');
        assert.ok(
          liveFrames.every((frame) => frame.run === runId),
          'every frame must be scoped to this run',
        );
        push('SSE first frame is run.started (id 1), every frame carries the run id', null);
      } catch (err) {
        push('SSE first frame is run.started (id 1), every frame carries the run id', err as Error);
      }

      const committed = liveFrames.filter((frame) => frame.type === 'run.step.committed');
      try {
        assert.deepEqual(
          committed.map((frame) => frameStepSeq(frame)),
          [1, 2, 3, 4],
          `expected committed seq 1,2,3,4 — got ${JSON.stringify(
            committed.map((frame) => frameStepSeq(frame)),
          )}`,
        );
        push(
          'SSE journals llm.call → tool.call → sandbox.exec → git.commit as committed steps 1,2,3,4',
          null,
        );
      } catch (err) {
        push(
          'SSE journals llm.call → tool.call → sandbox.exec → git.commit as committed steps 1,2,3,4',
          err as Error,
        );
      }

      try {
        const toolFrame = committed.find((frame) => frameStepSeq(frame) === 2);
        assert.ok(toolFrame, 'missing tool.call committed frame');
        const resultRef = (toolFrame.data as JsonRecord).resultRef as JsonRecord | undefined;
        assert.ok(resultRef, 'tool frame has no resultRef');
        assert.match(String(resultRef.requestHash), /^[0-9a-f]{64}$/);
        assert.match(String(resultRef.responseHash), /^[0-9a-f]{64}$/);
        assert.equal(resultRef.attempt, 1);
        assert.equal(resultRef.toolId, 'native:git.recon');
        push('tool.call frame carries canonical request/response hashes (64-hex, attempt 1)', null);
      } catch (err) {
        push('tool.call frame carries canonical request/response hashes (64-hex, attempt 1)', err as Error);
      }

      const sandboxFrame = committed.find((frame) => frameStepSeq(frame) === 3);
      try {
        assert.ok(sandboxFrame, 'missing sandbox.exec committed frame');
        const resultRef = (sandboxFrame.data as JsonRecord).resultRef as JsonRecord | undefined;
        assert.ok(resultRef, 'sandbox frame has no resultRef');
        assert.equal(resultRef.sessionId, 'ses_runs_e2e');
        assert.equal(resultRef.command, 'echo run-ready');
        push('sandbox.exec frame carries the runner session id and the shell command', null);
      } catch (err) {
        push('sandbox.exec frame carries the runner session id and the shell command', err as Error);
      }

      const gitFrame = committed.find((frame) => frameStepSeq(frame) === 4);
      let journalSha = '';
      try {
        assert.ok(gitFrame, 'missing git.commit committed frame');
        const resultRef = (gitFrame.data as JsonRecord).resultRef as JsonRecord | undefined;
        assert.ok(resultRef, 'git frame has no resultRef');
        journalSha = String(resultRef.sha ?? '');
        assert.match(journalSha, /^[0-9a-f]{40}$/);
        assert.equal(resultRef.branch, branch);
        assert.equal(resultRef.baseCommit, baseHead);
        push('git.commit frame carries the 40-hex sha on agent/<id> from baseCommit', null);
      } catch (err) {
        push('git.commit frame carries the 40-hex sha on agent/<id> from baseCommit', err as Error);
      }

      // --- sandbox wire (runner stub) -----------------------------------
      try {
        const createReq = sandbox.requests.find(
          (req) => req.method === 'POST' && req.path === '/api/session',
        );
        assert.ok(createReq, 'sandbox stub saw no POST /api/session');
        assert.match(String(createReq.authorization), /^Basic /, 'sandbox create is not Basic-authed');
        const decoded = Buffer.from(
          String(createReq.authorization).slice('Basic '.length),
          'base64',
        ).toString('utf8');
        assert.equal(decoded, `opencode:${process.env.OPENCODE_PASSWORD}`);
        const createBody = (createReq.body ?? {}) as JsonRecord;
        const location = (createBody.location ?? {}) as JsonRecord;
        assert.equal(location.directory, worktree, 'session location is not the run worktree');

        const shellReq = sandbox.requests.find(
          (req) => req.path === '/api/session/ses_runs_e2e/shell',
        );
        assert.ok(shellReq, 'sandbox stub saw no shell call');
        assert.equal(shellReq.authorization, createReq.authorization);
        const shellBody = (shellReq.body ?? {}) as JsonRecord;
        assert.equal(shellBody.command, 'echo run-ready');
        assert.equal(shellBody.directory, worktree);
        push('sandbox.exec creates an opencode session and runs the shell with Basic auth', null);
      } catch (err) {
        push('sandbox.exec creates an opencode session and runs the shell with Basic auth', err as Error);
      }

      // --- replay (append-only, no loss, no duplicate) -------------------
      try {
        const replay = await collectFrames(
          base,
          `/api/runs/${runId}/events?cursor=0`,
          authHeaders,
          fourStepsCommitted,
          30_000,
        );
        assert.equal(replay.status, 200);
        const replayCommitted = replay.frames.filter((frame) => frame.type === 'run.step.committed');
        assert.deepEqual(
          replayCommitted.map((frame) => frameStepSeq(frame)),
          [1, 2, 3, 4],
          'catch-up replay lost or duplicated a committed step',
        );
        const lastId = Math.max(...replay.frames.map((frame) => Number(frame.id)));
        assert.ok(Number.isSafeInteger(lastId) && lastId > 0, 'no ordered frame ids in replay');

        const tail = await collectFrames(
          base,
          `/api/runs/${runId}/events?cursor=${lastId}`,
          authHeaders,
          () => false,
          1500,
        );
        assert.equal(tail.status, 200);
        assert.equal(tail.frames.length, 0, `tail after cursor=${lastId} replayed frames`);
        push('SSE replay returns the same committed seqs, then tails nothing past the last id', null);
      } catch (err) {
        push('SSE replay returns the same committed seqs, then tails nothing past the last id', err as Error);
      }

      // --- terminal state ------------------------------------------------
      try {
        const deadline = Date.now() + 30_000;
        let status = '';
        while (Date.now() < deadline) {
          const res = await fetch(`${base}/api/runs/${runId}`, { headers: authHeaders });
          const body = (await res.json().catch(() => null)) as JsonRecord | null;
          status = String(body?.status ?? '');
          if (status === 'awaiting_human') break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        assert.equal(status, 'awaiting_human', `run never parked (last status ${status || 'unknown'})`);
        push('claim loop parks the completed run at awaiting_human', null);
      } catch (err) {
        push('claim loop parks the completed run at awaiting_human', err as Error);
      }

      // --- on-disk git effects ------------------------------------------
      try {
        const branches = git(JAIL_DIR, ['branch', '--list', branch]);
        assert.ok(branches.length > 0, `branch ${branch} was never created`);

        assert.ok(worktree.startsWith(JAIL_DIR), `worktree escaped the jail: ${worktree}`);
        assert.equal(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), branch);

        const trailerSha = git(worktree, ['log', '--grep', `Run-Id: ${runId}`, '--format=%H']);
        assert.ok(trailerSha.length > 0, 'trailered run commit not found in the worktree');
        assert.equal(trailerSha.split('\n')[0], journalSha, 'journaled sha != trailered commit');

        assert.doesNotThrow(
          () => git(worktree, ['merge-base', '--is-ancestor', baseHead, 'HEAD']),
          'baseCommit is not an ancestor of the run HEAD (Forward-Only violated)',
        );
        push('git effects: branch/worktree exist, Run-Id trailer matches the journal, base is an ancestor', null);
      } catch (err) {
        push('git effects: branch/worktree exist, Run-Id trailer matches the journal, base is an ancestor', err as Error);
      }

      // --- C4 stranger → 404 (no existence leak, JSON before SSE) -------
      {
        const { NotFoundException } = await import('@nestjs/common');
        (
          ProjectAccessService.prototype as unknown as { assertProjectAccessById: unknown }
        ).assertProjectAccessById = async (): Promise<never> => {
          throw new NotFoundException(`Project ${E2E_PROJECT_ID} not found`);
        };
        try {
          await check(
            'GET /api/runs/{id} stranger project → 404 not_found (no Retry-After)',
            `/api/runs/${runId}`,
            undefined,
            404,
            (res, body) => {
              assert.equal((body as { code?: string }).code, 'not_found');
              assert.equal(res.headers.get('Retry-After'), null);
            },
          );
          await check(
            'GET /api/runs/{id}/events stranger project → 404 JSON before SSE headers',
            `/api/runs/${runId}/events?cursor=0`,
            { headers: { accept: 'text/event-stream' } },
            404,
            (res, body) => {
              assert.match(res.headers.get('content-type') ?? '', /application\/json/);
              assert.equal((body as { code?: string }).code, 'not_found');
            },
          );
        } finally {
          (
            ProjectAccessService.prototype as unknown as { assertProjectAccessById: unknown }
          ).assertProjectAccessById = allowAccess;
        }
      }

      // --- caller mistakes / unknown run --------------------------------
      await check('POST /api/runs {} → 400 bad_request', '/api/runs', jsonBody({}), 400, (_res, body) => {
        assert.equal((body as { code?: string }).code, 'bad_request');
      });
      await check(
        'POST /api/runs non-uuid projectId → 400 bad_request',
        '/api/runs',
        jsonBody({ projectId: 'not-a-uuid' }),
        400,
        (_res, body) => {
          assert.equal((body as { code?: string }).code, 'bad_request');
        },
      );
      await check('GET /api/runs/not-a-uuid → 400 bad_request', '/api/runs/not-a-uuid', undefined, 400, (_res, body) => {
        assert.equal((body as { code?: string }).code, 'bad_request');
      });
      await check(
        'GET /api/runs/{random uuid} → 404 not_found',
        `/api/runs/${randomUUID()}`,
        undefined,
        404,
        (_res, body) => {
          assert.equal((body as { code?: string }).code, 'not_found');
        },
      );
      await check(
        'GET /api/runs/{id}/events?cursor=abc → 400 JSON before SSE headers',
        `/api/runs/${runId}/events?cursor=abc`,
        { headers: { accept: 'text/event-stream' } },
        400,
        (res, body) => {
          assert.match(res.headers.get('content-type') ?? '', /application\/json/);
          assert.equal((body as { code?: string }).code, 'bad_request');
        },
      );

      // --- swagger -------------------------------------------------------
      await check('swagger exposes the /api/runs surface', '/swagger/v1.json', undefined, 200, (_res, body) => {
        const doc = body as { paths?: Record<string, unknown> };
        const paths = doc.paths ?? {};
        assert.ok(paths['/api/runs'], 'missing /api/runs in swagger');
        assert.ok(paths['/api/runs/{id}'], 'missing /api/runs/{id} in swagger');
        assert.ok(paths['/api/runs/{id}/events'], 'missing /api/runs/{id}/events in swagger');
      });

      // --- guest ---------------------------------------------------------
      {
        const anon = await fetch(`${base}/api/runs/${runId}`);
        const anonBody = (await anon.json().catch(() => null)) as { code?: string } | null;
        try {
          assert.equal(anon.status, 401);
          assert.equal(anonBody?.code, 'unauthorized');
          push('GET /api/runs/{id} without Bearer → 401', null);
        } catch (err) {
          push('GET /api/runs/{id} without Bearer → 401', err as Error);
        }
      }
    }
  } finally {
    // Restore the logger BEFORE teardown: a pool 'error' emitted while the
    // container stops is real, but it must not be scanned as a suite log line.
    logMethods.forEach((m, i) => {
      (AppLogger.prototype as unknown as Record<string, unknown>)[m] = logOriginals[i];
    });
    (
      ProjectAccessService.prototype as unknown as { assertProjectAccessById: unknown }
    ).assertProjectAccessById = allowAccess;
    pathsProto.resolveUserStrict = originalResolveUserStrict;
    pathsProto.realStrictRoot = originalRealStrictRoot;
    pathsProto.assertInsideJail = originalAssertInsideJail;
    await app.close();
    await sandbox.close();
    await testDb.stop();
    rmSync(JAIL_DIR, { recursive: true, force: true });
    rmSync(E2E_ROOT, { recursive: true, force: true });
  }

  // Log discipline over the whole suite: warn/error one-liners, no
  // authorization material, no unserialized objects, no Basic password.
  const sandboxSecret = String(process.env.OPENCODE_PASSWORD ?? '');
  for (const l of logged) {
    if (l.method === 'warn' || l.method === 'error') {
      assert.ok(!l.text.includes('\n'), `${l.method} line is not a one-liner: ${l.text.slice(0, 120)}`);
    }
    assert.ok(!l.text.includes('Bearer '), 'authorization material leaked into a log line');
    assert.ok(!l.text.includes('[object Object]'), 'unserialized object in a log line');
    assert.ok(
      sandboxSecret.length === 0 || !l.text.includes(sandboxSecret),
      'opencode password leaked into a log line',
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nruns e2e (strict): ${results.length - failed.length}/${results.length} passed`);
  // Explicit exit: an aborted SSE socket may otherwise keep the bun loop alive.
  process.exit(failed.length > 0 ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error(`runs e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
