/**
 * ExternalClient e2e — retry / timeout / envelope against a flaky upstream.
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage:
 *   `bun run build && bun dist/common/external/external-client.e2e.js`
 *
 * Boots the real AppModule and points OPENCODE_URL at a local flaky
 * node:http server (no external network, never logs secrets):
 *  - GET /session fails 2×500 then 200 live → retry recovers (live body,
 *    3 upstream hits, no error);
 *  - GET /messages always 503 → retries exhaust (3 upstream hits) then 503
 *    EXTERNAL_UPSTREAM_5XX envelope with Retry-After (no mock fallback);
 *  - POST /chat resets the connection → network failure (POST runs once:
 *    exactly 1 upstream hit) then 503 EXTERNAL_UNAVAILABLE envelope with
 *    Retry-After (no mock echo);
 *  - POST /chat {} → 400 envelope { code, message, correlationId } with the
 *    x-correlation-id response header echoed.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// --- deterministic env (BEFORE AppModule import — ConfigModule.validate runs at create) ---
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '1000';
process.env.EXTERNAL_RETRY_MAX_ATTEMPTS = '3';
process.env.EXTERNAL_RETRY_BASE_DELAY_MS = '50';
process.env.EXTERNAL_RETRY_MAX_DELAY_MS = '200';
process.env.OPENCODE_URL = 'http://127.0.0.1:9'; // replaced with the flaky server once listening
process.env.DATABASE_URL = '';
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST']) {
  delete process.env[key];
}

const LIVE_SESSION = {
  id: 'live-session-1',
  title: 'Live session via retry',
  createdAt: new Date().toISOString(),
  model: 'live',
};

interface Flaky {
  server: Server;
  url: string;
  hits: (path: string) => number;
  close: () => Promise<void>;
}

function startFlaky(): Promise<Flaky> {
  const counts = new Map<string, number>();
  const hit = (p: string): number => counts.set(p, (counts.get(p) ?? 0) + 1).get(p) as number;
  const json = (res: ServerResponse, status: number, body: unknown, delayMs = 0): void => {
    const send = (): void => {
      const raw = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(raw);
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] as string;
    if (path === '/session') {
      // Fail twice with 500, then serve live — GET retry must recover.
      if (hit('/session') <= 2) {
        json(res, 500, { error: 'flaky' });
        return;
      }
      json(res, 200, LIVE_SESSION);
      return;
    }
    if (path === '/messages') {
      hit('/messages');
      json(res, 503, { error: 'always unavailable' });
      return;
    }
    if (path === '/chat') {
      hit('/chat');
      // Reset the connection — client sees a network failure (POST runs once,
      // non-idempotent guard: exactly 1 upstream hit, no retry).
      req.resume();
      req.socket.destroy();
      return;
    }
    json(res, 404, { error: 'unknown' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        hits: (p: string) => counts.get(p) ?? 0,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function main(): Promise<void> {
  const flaky = await startFlaky();
  // OpencodeService + ExternalClient resolve env per call — live override works post-boot.
  process.env.OPENCODE_URL = flaky.url;

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../app.module.js');
  const { configureApp } = await import('../../app.setup.js');

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  const base = await app.getUrl();

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

  try {
    await check('GET retry recovers: /session live after 2×500 (3 upstream hits)', async () => {
      const res = await fetch(`${base}/api/v1/session`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { id?: string };
      assert.equal(body.id, LIVE_SESSION.id);
      assert.equal(flaky.hits('/session'), 3);
    });

    await check('GET retries exhaust: /messages 503 + Retry-After (3 upstream hits)', async () => {
      const res = await fetch(`${base}/api/v1/messages?sessionId=s1`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        correlationId?: string;
      };
      assert.equal(body.code, 'EXTERNAL_UPSTREAM_5XX');
      assert.equal(typeof body.message, 'string');
      assert.equal(typeof body.correlationId, 'string');
      assert.equal(res.headers.get('x-correlation-id'), body.correlationId);
      assert.equal(res.headers.get('Retry-After'), '30');
      assert.equal(flaky.hits('/messages'), 3);
    });

    await check('POST runs once on reset: /chat 503 + Retry-After (1 upstream hit)', async () => {
      const res = await fetch(`${base}/api/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        correlationId?: string;
      };
      assert.equal(body.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(body.message, 'сервис временно недоступен, повторите позже');
      assert.equal(typeof body.correlationId, 'string');
      assert.equal(res.headers.get('x-correlation-id'), body.correlationId);
      assert.equal(res.headers.get('Retry-After'), '30');
      assert.equal(flaky.hits('/chat'), 1);
    });

    await check('envelope: POST /chat {} → 400 { code, message, correlationId }', async () => {
      const res = await fetch(`${base}/api/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        correlationId?: string;
      };
      assert.equal(body.code, 'bad_request');
      assert.equal(typeof body.message, 'string');
      assert.equal(typeof body.correlationId, 'string');
      assert.equal(res.headers.get('x-correlation-id'), body.correlationId);
    });
  } finally {
    await app.close();
    await flaky.close();
  }

  console.log(`\nexternal-client e2e: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`external-client e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
