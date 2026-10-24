/**
 * ExternalServiceError unit checks — self-contained runner (no new deps,
 * plain node:assert), same constraint as env.spec.ts:
 *   `bun run build && bun dist/common/external/external-error.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers: fixed codes, 401/403/404/429/503 mapping, httpStatus derivation,
 * isRetryable flags, timeout detection, never-leak-messages.
 */
import assert from 'node:assert/strict';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
  httpStatusFor,
  isRetryableStatus,
  isTimeoutError,
  timeoutError,
} from './external-error';

const checks: Array<{ name: string; run: () => void }> = [
  {
    name: '429 maps to EXTERNAL_RATE_LIMITED (retryable, http 429)',
    run: () => {
      const err = fromStatus('opencode', 'getSession', 429, 2);
      assert.equal(err.code, 'EXTERNAL_RATE_LIMITED');
      assert.equal(err.isRetryable, true);
      assert.equal(err.httpStatus, 429);
      assert.equal(err.attempt, 2);
      assert.equal(err.service, 'opencode');
      assert.equal(err.operation, 'getSession');
    },
  },
  {
    name: '503 maps to EXTERNAL_UPSTREAM_5XX (retryable, status passes through)',
    run: () => {
      const err = fromStatus('opencode', 'getSession', 503, 1);
      assert.equal(err.code, 'EXTERNAL_UPSTREAM_5XX');
      assert.equal(err.isRetryable, true);
      assert.equal(err.httpStatus, 503);
    },
  },
  {
    name: '500 maps to EXTERNAL_UPSTREAM_5XX with http 500',
    run: () => {
      assert.equal(fromStatus('opencode', 'op', 500).httpStatus, 500);
    },
  },
  {
    name: '401/403 for github map to GITHUB_AUTH (not retryable)',
    run: () => {
      for (const status of [401, 403]) {
        const err = fromStatus('github', 'listRepos', status);
        assert.equal(err.code, 'GITHUB_AUTH');
        assert.equal(err.isRetryable, false);
        assert.equal(err.httpStatus, status);
      }
    },
  },
  {
    name: '401 for non-github maps to EXTERNAL_UNAVAILABLE (http 503)',
    run: () => {
      const err = fromStatus('opencode', 'getSession', 401);
      assert.equal(err.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(err.httpStatus, 503);
    },
  },
  {
    name: '404 maps to EXTERNAL_UNAVAILABLE (never retryable)',
    run: () => {
      const err = fromStatus('github', 'listRepos', 404);
      assert.equal(err.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(err.isRetryable, false);
      assert.equal(err.httpStatus, 503);
    },
  },
  {
    name: 'timeoutError is EXTERNAL_TIMEOUT (retryable, http 504)',
    run: () => {
      const err = timeoutError('opencode', 'sendChat', 3);
      assert.equal(err.code, 'EXTERNAL_TIMEOUT');
      assert.equal(err.isRetryable, true);
      assert.equal(err.httpStatus, 504);
      assert.equal(err.attempt, 3);
      assert.ok(err instanceof Error);
      assert.ok(err instanceof ExternalServiceError);
    },
  },
  {
    name: 'isTimeoutError detects AbortError + timeout messages only',
    run: () => {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      assert.equal(isTimeoutError(abort), true);
      assert.equal(isTimeoutError(new Error('fetch timeout exceeded')), true);
      assert.equal(isTimeoutError(new Error('upstream_500')), false);
      assert.equal(isTimeoutError(timeoutError('s', 'o')), true);
      assert.equal(isTimeoutError(null), false);
      assert.equal(isTimeoutError('timeout'), false);
    },
  },
  {
    name: 'isRetryableStatus: 429/5xx true, other 4xx false',
    run: () => {
      assert.equal(isRetryableStatus(429), true);
      assert.equal(isRetryableStatus(500), true);
      assert.equal(isRetryableStatus(503), true);
      assert.equal(isRetryableStatus(400), false);
      assert.equal(isRetryableStatus(401), false);
      assert.equal(isRetryableStatus(404), false);
      assert.equal(isRetryableStatus(200), false);
    },
  },
  {
    name: 'fromUnknown: Octokit-style { status } goes through fromStatus',
    run: () => {
      const err = fromUnknown('github', 'listRepos', { status: 403 }, 1);
      assert.equal(err.code, 'GITHUB_AUTH');
    },
  },
  {
    name: 'fromUnknown: network error → EXTERNAL_UNAVAILABLE retryable without echo',
    run: () => {
      const secretish = new Error('fetch failed for https://x with token hunter2');
      const err = fromUnknown('opencode', 'getSession', secretish, 1);
      assert.equal(err.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(err.isRetryable, true);
      assert.ok(!err.message.includes('hunter2'), 'upstream text leaked into message');
      assert.ok(!err.message.includes('https://'), 'upstream text leaked into message');
    },
  },
  {
    name: 'fromUnknown: ExternalServiceError passes through untouched',
    run: () => {
      const orig = timeoutError('s', 'o', 2);
      assert.equal(fromUnknown('s', 'o', orig, 9), orig);
    },
  },
  {
    name: 'httpStatusFor defaults: unknown 5xx-less input → 502/503/401',
    run: () => {
      assert.equal(httpStatusFor('EXTERNAL_UPSTREAM_5XX'), 502);
      assert.equal(httpStatusFor('EXTERNAL_UPSTREAM_5XX', 200), 502);
      assert.equal(httpStatusFor('EXTERNAL_UNAVAILABLE'), 503);
      assert.equal(httpStatusFor('GITHUB_AUTH'), 401);
      assert.equal(httpStatusFor('EXTERNAL_TIMEOUT'), 504);
      assert.equal(httpStatusFor('EXTERNAL_RATE_LIMITED'), 429);
    },
  },
];

let failed = 0;
for (const c of checks) {
  try {
    c.run();
    console.log(`ok - ${c.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
  }
}
if (failed > 0) {
  console.error(`${failed}/${checks.length} external-error checks failed`);
  process.exitCode = 1;
} else {
  console.log(`${checks.length}/${checks.length} external-error checks passed`);
}
