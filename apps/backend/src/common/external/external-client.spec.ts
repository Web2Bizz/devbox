/**
 * ExternalClient unit checks — self-contained runner (no new deps, plain
 * node:assert), same constraint as the *.e2e.ts runners:
 *   `bun run build && bun dist/common/external/external-client.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the diagnostic-serialization rule on the transport path (the same
 * invariant api-error.filter enforces): the `[external] cause … detail=`
 * debug line must carry a SERIALIZED, key-redacted value — a plain-object
 * cause (Octokit/sdk-shaped `{status: 400, _tag: 'InvalidRequestError'}`)
 * must ride as JSON (never `[object Object]`), values under known secret
 * keys are redacted, and warn/error stay one-liners without stacks (stacks
 * go to debug only). Retry/status behavior is untouched — only the
 * diagnost string serialization.
 */
import assert from 'node:assert/strict';
import { AppLogger } from '../app-logger.service';
import { ExternalClient } from './external-client';
import { ExternalServiceError } from './external-error';

const SECRET_VALUE = 'marker-secret-never-log-9f3a';

/** Captures every AppLogger call for the duration of `fn`, then restores. */
async function withLogCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logged: Array<{ method: string; text: string }> }> {
  const logged: Array<{ method: string; text: string }> = [];
  const methods = ['debug', 'info', 'warn', 'error'] as const;
  const proto = AppLogger.prototype as unknown as Record<string, (...a: unknown[]) => void>;
  const originals = methods.map((m) => proto[m]);
  methods.forEach((m, i) => {
    proto[m] = function (...args: unknown[]) {
      logged.push({
        method: m,
        text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      });
      return (originals[i] as (...a: unknown[]) => void).apply(this, args);
    };
  });
  try {
    const result = await fn();
    return { result, logged };
  } finally {
    methods.forEach((m, i) => {
      proto[m] = originals[i] as (...a: unknown[]) => void;
    });
  }
}

/** Patched transport seam: doFetch throws whatever `thrown` is, once per call. */
const proto = ExternalClient.prototype as unknown as Record<string, unknown>;
const originalDoFetch = proto.doFetch;

function clientThrowing(thrown: unknown, counter: { calls: number }): ExternalClient {
  const client = new ExternalClient(new AppLogger('ExternalClientSpec'));
  proto.doFetch = async (): Promise<Response> => {
    counter.calls += 1;
    throw thrown;
  };
  return client;
}

function restoreDoFetch(): void {
  // Write the ORIGINAL prototype method back (delete would lose it for the
  // whole process — bun test dist shares it between suites).
  proto.doFetch = originalDoFetch;
}

const checks: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: 'object cause → [external] cause detail is JSON (no [object Object]), secret key redacted',
    run: async () => {
      const counter = { calls: 0 };
      const client = clientThrowing(
        {
          status: 400,
          _tag: 'InvalidRequestError',
          message: 'Expected object',
          kind: 'Payload',
          token: SECRET_VALUE,
        },
        counter,
      );
      try {
        const { logged } = await withLogCapture(async () => {
          return client
            .fetchWithRetry('http://127.0.0.1:9/api/session', { method: 'GET' }, {
              service: 'opencode',
              operation: 'createSession',
              correlationId: 'cid-cause-1',
              retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
            })
            .then(
              () => null,
              (e: unknown) => e as ExternalServiceError,
            );
        });

        // Status/retry behavior unchanged: single attempt, honest 4xx code.
        assert.equal(counter.calls, 1);
        // The transport threw the classified error before the catch-logger:
        // assert the debug cause line exists and is serialized honestly.
        const causeLine = logged.find((l) => l.text.includes('[external] cause '));
        // classifyTransportError throws from inside the withRetry fn, so the
        // outer catch logs the ExternalServiceError branch: cause detail=.
        if (!causeLine) {
          throw new Error(
            `expected an [external] cause debug line, got: ${logged.map((l) => l.text).join(' | ').slice(0, 500)}`,
          );
        }
        assert.match(causeLine.text, /code=EXTERNAL_BAD_REQUEST/);
        assert.ok(!causeLine.text.includes('[object Object]'), 'cause serialized as [object Object]');
        assert.ok(causeLine.text.includes('InvalidRequestError'), 'cause detail lost the shape signal');
        assert.ok(!causeLine.text.includes(SECRET_VALUE), 'secret value leaked into the debug line');
        assert.ok(causeLine.text.includes('"token":"[redacted]"'), 'secret key not redacted');
        // warn/error one-liners: no stack, no newline.
        for (const l of logged) {
          if (l.method === 'warn' || l.method === 'error') {
            assert.ok(!l.text.includes('\n'), `${l.method} line is not a one-liner`);
          }
        }
      } finally {
        restoreDoFetch();
      }
    },
  },
  {
    name: 'Error cause → stack/message rides on debug only; warn/error stay one-liners',
    run: async () => {
      const counter = { calls: 0 };
      const err = new Error('fetch failed');
      err.stack = 'Error: fetch failed\n    at Object.<anonymous> (fake:1:1)';
      const client = clientThrowing(err, counter);
      try {
        const { logged } = await withLogCapture(async () => {
          return client
            .fetchWithRetry('http://127.0.0.1:9/whatever', { method: 'GET' }, {
              service: 'opencode',
              operation: 'getSession',
              retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
            })
            .then(
              () => null,
              (e: unknown) => e as ExternalServiceError,
            );
        });
        assert.equal(counter.calls, 1);
        const causeLine = logged.find((l) => l.text.includes('[external] cause '));
        if (!causeLine) {
          throw new Error(
            `expected an [external] cause debug line, got: ${logged.map((l) => l.text).join(' | ').slice(0, 500)}`,
          );
        }
        assert.ok(causeLine.text.includes('fetch failed'), 'Error cause message lost');
        assert.ok(causeLine.method === 'debug', 'cause stack leaked to a non-debug level');
        for (const l of logged) {
          if (l.method === 'warn' || l.method === 'error') {
            assert.ok(!l.text.includes('\n'), `${l.method} line is not a one-liner`);
            assert.ok(!l.text.includes(' at Object.<anonymous>'), 'stack leaked outward');
          }
        }
      } finally {
        restoreDoFetch();
      }
    },
  },
  {
    name: 'fetchWithRetry still resolves non-retryable 4xx responses unchanged (serialization did not alter transport)',
    run: async () => {
      // Upstream answered 404 as a real Response: the transport must NOT
      // throw here (honest 4xx normalization belongs to fromStatus callers),
      // and no cause line must be logged.
      const client = new ExternalClient(new AppLogger('ExternalClientSpec'));
      const proto = ExternalClient.prototype as unknown as Record<string, unknown>;
      proto.doFetch = async (): Promise<Response> =>
        new Response(JSON.stringify({ _tag: 'NotFoundError' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      try {
        const { logged } = await withLogCapture(async () => {
          return client.fetchWithRetry('http://127.0.0.1:9/api/session/ses_x', { method: 'GET' }, {
            service: 'opencode',
            operation: 'getSession',
            retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
          });
        });
        // Non-retryable statuses pass through as resolved responses.
        assert.equal(logged.find((l) => l.text.includes('[external] cause ')), undefined);
        assert.ok(logged.some((l) => l.text.includes('[external] success ') && l.text.includes('status=404')));
      } finally {
        restoreDoFetch();
      }
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
    console.error(`${failed}/${checks.length} external-client checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} external-client checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} external-client checks passed`);
  }
}

void main();
