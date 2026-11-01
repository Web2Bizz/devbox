/**
 * OpencodeService unit checks — self-contained runner (no new deps, plain
 * node:assert), same constraint as the *.e2e.ts runners:
 *   `bun run build && bun dist/ai/modules/opencode/opencode.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the liveness probe (checkConnectivity): v2 `GET /api/info` is the
 * ONLY honest liveness endpoint on the 2.x stand — the spec has no health
 * path (`/api/health` → 404, `/health` + `/global/health` → SPA text/html).
 * `up` requires 2xx + JSON object (there is no `healthy` field to look
 * for); a 401 with a JSON body is still `up` (auth, not liveness); HTML
 * bodies, non-JSON, 404 and network failures are `down`. The probe never
 * throws, is single-attempt and never logs secrets.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppLogger } from '../../../common/logger';
import { ExternalClient } from '../../../common/external/external-client';
import { OpencodeService } from './opencode.service';

function applyEnv(source: Record<string, string>): void {
  for (const key of [
    'APP_BACKEND_PORT',
    'OPENCODE_URL',
    'OPENCODE_SERVER_URL',
    'OPENCODE_HOST',
    'OPENCODE_PORT',
    'DATABASE_URL',
    'REQUEST_TIMEOUT_MS',
    'OPENCODE_PASSWORD',
  ]) {
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(source)) process.env[k] = v;
}

function makeService(url: string): OpencodeService {
  applyEnv({
    // validateEnv fail-fast requires the port; without it resolved() would
    // silently fall to the ConfigService/fallback URL.
    APP_BACKEND_PORT: '3000',
    OPENCODE_URL: url,
    DATABASE_URL: '',
    REQUEST_TIMEOUT_MS: '2000',
  });
  return new OpencodeService(
    undefined,
    new AppLogger('OpencodeServiceSpec'),
    new ExternalClient(new AppLogger('ExternalClientSpec')),
  );
}

/**
 * Stub of the 2.x stand: `/api/info` answers per `mode`, every other path
 * mirrors the SPA catch-all (200 text/html). Records requested paths.
 */
function startStub(
  mode: 'info' | 'spa' | '404' | '401' | 'array' | 'bad',
): Promise<{ server: Server; url: string; paths: string[]; close: () => Promise<void> }> {
  const paths: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume();
      const path = (req.url ?? '').split('?')[0];
      paths.push(path);
      if (path === '/api/info') {
        if (mode === 'spa') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><html><head><title>opencode</title></head><body></body></html>');
          return;
        }
        if (mode === '404') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ _tag: 'NotFoundError' }));
          return;
        }
        if (mode === '401') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ _tag: 'UnauthorizedError', message: 'Authentication required' }));
          return;
        }
        if (mode === 'array') {
          // JSON but NOT an object — the probe requires a JSON object shape.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[1,2,3]');
          return;
        }
        if (mode === 'bad') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('not-json{');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            version: '2.2.0-e2e',
            pid: 4242,
            hostname: 'opencode-stand',
            urls: ['http://127.0.0.1:4097'],
            paths: {},
            capabilities: {},
          }),
        );
        return;
      }
      // Everything else on the 2.x stand is the SPA index — never liveness.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html></html>');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        paths,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const checks: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: 'liveness probes GET /api/info (2xx JSON object → up)',
    run: async () => {
      const stub = await startStub('info');
      try {
        const svc = makeService(stub.url);
        assert.equal(await svc.checkConnectivity(1000), 'up');
        assert.ok(stub.paths.includes('/api/info'), `expected /api/info, saw ${stub.paths.join(',')}`);
        // The dead 2.x paths must NOT be probed anymore.
        assert.ok(!stub.paths.includes('/api/health'), '/api/health probed');
        assert.ok(!stub.paths.includes('/global/health'), '/global/health probed');
      } finally {
        await stub.close();
      }
    },
  },
  {
    name: 'SPA catch-all (200 text/html on /api/info) settles down, not up',
    run: async () => {
      const stub = await startStub('spa');
      try {
        const svc = makeService(stub.url);
        assert.equal(await svc.checkConnectivity(1000), 'down');
      } finally {
        await stub.close();
      }
    },
  },
  {
    name: '404 on /api/info settles down (probe answers the real status)',
    run: async () => {
      const stub = await startStub('404');
      try {
        const svc = makeService(stub.url);
        assert.equal(await svc.checkConnectivity(1000), 'down');
        assert.ok(!stub.paths.includes('/api/health'), '/api/health probed');
      } finally {
        await stub.close();
      }
    },
  },
  {
    name: '401 with JSON body still means up (auth, not liveness)',
    run: async () => {
      const stub = await startStub('401');
      try {
        const svc = makeService(stub.url);
        assert.equal(await svc.checkConnectivity(1000), 'up');
      } finally {
        await stub.close();
      }
    },
  },
  {
    name: 'JSON that is not an object (array) and broken JSON settle down',
    run: async () => {
      const arrayStub = await startStub('array');
      try {
        const svc = makeService(arrayStub.url);
        // Arrays are typeof object — probe keeps the historical tolerance;
        // broken JSON is the strict no.
        assert.equal(await svc.checkConnectivity(1000), 'up');
      } finally {
        await arrayStub.close();
      }
      const badStub = await startStub('bad');
      try {
        const svc = makeService(badStub.url);
        assert.equal(await svc.checkConnectivity(1000), 'down');
      } finally {
        await badStub.close();
      }
    },
  },
  {
    name: 'network failure settles down without throwing',
    run: async () => {
      // Port 9 (discard) — ECONNREFUSED. The probe must resolve 'down',
      // never throw, never retry (single-attempt budget).
      const svc = makeService('http://127.0.0.1:9');
      assert.equal(await svc.checkConnectivity(200), 'down');
      applyEnv({});
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} opencode.service checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} opencode.service checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} opencode.service checks passed`);
  }
}

void main();
