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
 * - POST prompt/command/shell validate bodies (400 envelope);
 *   GET messages validates ?limit (400 envelope);
 * - /health stays 200; swagger v1 JSON exposes the opencode tag/paths.
 * Never logs secrets; reports db 'down' (strict Postgres) (no external network).
 *
 * Live mode (opt-in): OPENCODE_LIVE_URL=http://127.0.0.1:4096 bun
 * dist/opencode/opencode.e2e.js — after the down phase, respawns itself with
 * OPENCODE_URL=<live> and asserts live 200s (create/patch/fork/status,
 * messages list with limit cursor, SSE headers, global/health version ==
 * pinned @opencode-ai/sdk version). LLM-dependent 200s (prompt/command/shell
 * execution) are intentionally NOT asserted — the temp server has no model
 * credentials; their 400-validation is covered in down mode.
 */
import assert from 'node:assert/strict';

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
    await check('GET /health 200 (db down, strict Postgres)', '/health', undefined, 200, (_res, body) => {
      const b = body as { status?: string; db?: string };
      assert.equal(b.status, 'ok');
      assert.equal(b.db, 'down');
    });

    if (LIVE_MODE) {
      await liveChecks(check, json, base);
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
      await check('CORS echo on /api/opencode/session (503)', '/api/opencode/session', { headers: { origin: 'http://localhost:8080' } }, 503, (res) => {
        assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8080');
      });
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
  // Sdk mirror — every live path answers 503 when upstream is down.
  await check('GET /api/opencode/session down → 503 + Retry-After', '/api/opencode/session', undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('POST /api/opencode/session down → 503 + Retry-After', '/api/opencode/session', json({ title: 'e2e' }), 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/session/status down → 503', '/api/opencode/session/status', undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/session/:id down → 503', '/api/opencode/session/ses_nope', undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('DELETE /api/opencode/session/:id down → 503', '/api/opencode/session/ses_nope', { method: 'DELETE' }, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('PATCH /api/opencode/session/:id down → 503', '/api/opencode/session/ses_nope', { ...json({ title: 'e2e' }), method: 'PATCH' }, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('POST /api/opencode/session/:id/fork down → 503', '/api/opencode/session/ses_nope/fork', json({}), 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/session/:id/message down → 503', '/api/opencode/session/ses_nope/message', undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/session/:id/message?limit=5 down → 503', '/api/opencode/session/ses_nope/message?limit=5&before=msg_nope', undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check(
    'GET /api/opencode/session/:id/message?limit=abc → 400 envelope',
    '/api/opencode/session/ses_nope/message?limit=abc',
    undefined,
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check(
    'GET /api/opencode/session/:id/message?limit=-1 → 400 envelope',
    '/api/opencode/session/ses_nope/message?limit=-1',
    undefined,
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check('GET /api/opencode/session/:id/message/:messageID down → 503', '/api/opencode/session/ses_nope/message/msg_nope', undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check(
    'POST /api/opencode/session/:id/message down → 503',
    '/api/opencode/session/ses_nope/message',
    json({ parts: [{ type: 'text', text: 'hi' }] }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/message full body (model/agent/system/tools) down → 503',
    '/api/opencode/session/ses_nope/message',
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
    '/api/opencode/session/ses_nope/message',
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check(
    'POST /api/opencode/session/:id/prompt_async valid → 503',
    '/api/opencode/session/ses_nope/prompt_async',
    json({ parts: [{ type: 'text', text: 'hi' }] }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/prompt_async {} → 400 envelope',
    '/api/opencode/session/ses_nope/prompt_async',
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check(
    'POST /api/opencode/session/:id/command valid → 503',
    '/api/opencode/session/ses_nope/command',
    json({ command: 'test', arguments: 'arg' }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/command {} → 400 envelope',
    '/api/opencode/session/ses_nope/command',
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check(
    'POST /api/opencode/session/:id/shell valid → 503',
    '/api/opencode/session/ses_nope/shell',
    json({ agent: 'general', command: 'echo hi' }),
    503,
    (res, body) => {
      assertUnavailable(body, res);
    },
  );
  await check(
    'POST /api/opencode/session/:id/shell {} → 400 envelope',
    '/api/opencode/session/ses_nope/shell',
    json({}),
    400,
    (_res, body) => {
      assert.equal((body as { code?: string }).code, 'bad_request');
    },
  );
  await check('POST /api/opencode/session/:id/abort down → 503', '/api/opencode/session/ses_nope/abort', json({}), 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check('GET /api/opencode/config/providers down → 503', '/api/opencode/config/providers', undefined, 503, (res, body) => {
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

async function liveChecks(check: CheckFn, json: (obj: unknown) => RequestInit, base: string): Promise<void> {
  // Live 200s through the proxy (no mocks — upstream is the real server).
  // LLM-dependent executions (prompt/command/shell runs) are intentionally
  // NOT asserted: the temp server has no model credentials.
  const { readFile } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const require = createRequire(__filename);
  const sdkPkg = JSON.parse(
    await readFile(require.resolve('@opencode-ai/sdk/package.json'), 'utf8'),
  ) as { version?: string };
  assert.ok(sdkPkg.version, 'pinned @opencode-ai/sdk version readable');

  await check('live GET /api/opencode/global/health 200 + version == sdk pin', '/api/opencode/global/health', undefined, 200, (_res, body) => {
    const b = body as { healthy?: boolean; version?: string };
    assert.equal(b.healthy, true);
    assert.equal(typeof b.version, 'string');
    assert.equal(b.version, sdkPkg.version, `server ${b.version} !== sdk pin ${sdkPkg.version}`);
  });

  let sessionId = '';
  await check('live POST /api/opencode/session 200', '/api/opencode/session', json({ title: 'e2e-live' }), 200, (_res, body) => {
    const b = body as { id?: string };
    assert.equal(typeof b.id, 'string');
    sessionId = b.id as string;
  });
  assert.ok(sessionId, 'session id captured for follow-up live checks');

  await check('live GET /api/opencode/session/status 200', '/api/opencode/session/status', undefined, 200, (_res, body) => {
    assert.equal(typeof body, 'object');
  });
  await check('live PATCH /api/opencode/session/:id 200', `/api/opencode/session/${sessionId}`, { ...json({ title: 'e2e-live-renamed' }), method: 'PATCH' }, 200, (_res, body) => {
    assert.equal((body as { title?: string }).title, 'e2e-live-renamed');
  });
  await check('live GET /api/opencode/session/:id/message?limit=1 200 array', `/api/opencode/session/${sessionId}/message?limit=1`, undefined, 200, (res, body) => {
    assert.ok(Array.isArray(body), `expected array, got ${JSON.stringify(body)?.slice(0, 120)}`);
    // Cursor passthrough documented; upstream currently sends none — assert
    // only the plumbing (header read must not crash the 200).
    assert.equal(typeof res.headers.get('content-type'), 'string');
  });
  await check('live POST /api/opencode/session/:id/fork 200', `/api/opencode/session/${sessionId}/fork`, json({}), 200, (_res, body) => {
    assert.equal(typeof (body as { id?: string }).id, 'string');
  });
  // Upstream 404 (unknown message) surfaces through the uniform 503 mapping.
  await check('live GET unknown message → 503 (uniform upstream mapping)', `/api/opencode/session/${sessionId}/message/msg_nope`, undefined, 503, (res, body) => {
    assertUnavailable(body, res);
  });
  await check(
    'live POST /api/opencode/session/:id/prompt_async {} → 400 envelope',
    `/api/opencode/session/${sessionId}/prompt_async`,
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
      headers: { accept: 'text/event-stream' },
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
