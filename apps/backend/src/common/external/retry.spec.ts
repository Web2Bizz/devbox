/**
 * withRetry unit checks — self-contained runner (no new deps, plain
 * node:assert), same constraint as env.spec.ts:
 *   `bun run build && bun dist/common/external/retry.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers: backoff math + cap, deterministic no-jitter mode, idempotency
 * guard (POST runs once without the flag), no-retry on 4xx, retry on
 * 429/5xx/timeout/network, attempt exhaustion, maxAttempts clamp.
 */
import assert from 'node:assert/strict';
import {
  computeBackoffDelay,
  isIdempotentMethod,
  isRetryableError,
  resolveRetryOptions,
  withRetry,
} from './retry';
import {
  ExternalServiceError,
  fromStatus,
  timeoutError,
} from './external-error';

const noSleep = () => Promise.resolve();
const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'backoff doubles and caps (deterministic, jitter off)',
    run: () => {
      assert.equal(computeBackoffDelay(1, 200, 2000, false), 200);
      assert.equal(computeBackoffDelay(2, 200, 2000, false), 400);
      assert.equal(computeBackoffDelay(3, 200, 2000, false), 800);
      assert.equal(computeBackoffDelay(4, 200, 2000, false), 1600);
      assert.equal(computeBackoffDelay(5, 200, 2000, false), 2000);
      assert.equal(computeBackoffDelay(9, 200, 2000, false), 2000);
    },
  },
  {
    name: 'jitter stays within [half, full] of the exponential',
    run: () => {
      for (let i = 0; i < 50; i++) {
        const d = computeBackoffDelay(2, 200, 2000, true);
        assert.ok(d >= 200 && d <= 400, `jitter out of range: ${d}`);
      }
    },
  },
  {
    name: 'isIdempotentMethod: GET/HEAD yes, POST/PUT/PATCH/DELETE no',
    run: () => {
      assert.equal(isIdempotentMethod('GET'), true);
      assert.equal(isIdempotentMethod(undefined), true);
      assert.equal(isIdempotentMethod('HEAD'), true);
      assert.equal(isIdempotentMethod('POST'), false);
      assert.equal(isIdempotentMethod('PUT'), false);
      assert.equal(isIdempotentMethod('PATCH'), false);
      assert.equal(isIdempotentMethod('DELETE'), false);
      assert.equal(isIdempotentMethod('post'), false);
    },
  },
  {
    name: 'resolveRetryOptions clamps maxAttempts to 1..10, maxDelay >= base',
    run: () => {
      assert.equal(resolveRetryOptions({}).maxAttempts, 3);
      assert.equal(resolveRetryOptions({ maxAttempts: 0 }).maxAttempts, 1);
      assert.equal(resolveRetryOptions({ maxAttempts: 99 }).maxAttempts, 10);
      const r = resolveRetryOptions({ baseDelayMs: 500, maxDelayMs: 100 });
      assert.equal(r.maxDelayMs, 500);
    },
  },
  {
    name: 'isRetryableError: 429/5xx/timeout/network true, 4xx false',
    run: () => {
      assert.equal(isRetryableError(fromStatus('s', 'o', 429)), true);
      assert.equal(isRetryableError(fromStatus('s', 'o', 503)), true);
      assert.equal(isRetryableError(timeoutError('s', 'o')), true);
      assert.equal(isRetryableError({ status: 500 }), true);
      assert.equal(isRetryableError(new Error('fetch failed')), true);
      assert.equal(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:9')), true);
      assert.equal(isRetryableError(fromStatus('s', 'o', 400)), false);
      assert.equal(isRetryableError(fromStatus('s', 'o', 404)), false);
      assert.equal(isRetryableError({ status: 404 }), false);
      assert.equal(isRetryableError(new Error('upstream_400')), false);
    },
  },
  {
    name: 'GET retries 500s then succeeds (attempt numbers 1..3)',
    run: async () => {
      const seen: number[] = [];
      const res = await withRetry(
        async (attempt) => {
          seen.push(attempt);
          if (attempt < 3) throw fromStatus('s', 'o', 500, attempt);
          return 'ok';
        },
        { maxAttempts: 3, jitter: false, sleep: noSleep },
      );
      assert.equal(res, 'ok');
      assert.deepEqual(seen, [1, 2, 3]);
    },
  },
  {
    name: 'GET gives up after maxAttempts and rethrows the last error',
    run: async () => {
      let calls = 0;
      try {
        await withRetry(
          async () => {
            calls += 1;
            throw fromStatus('s', 'o', 503, calls);
          },
          { maxAttempts: 3, jitter: false, sleep: noSleep },
        );
        assert.fail('expected throw');
      } catch (err) {
        assert.ok(err instanceof ExternalServiceError);
        assert.equal((err as ExternalServiceError).code, 'EXTERNAL_UPSTREAM_5XX');
      }
      assert.equal(calls, 3);
    },
  },
  {
    name: 'POST without the flag runs exactly once (no retry on 503)',
    run: async () => {
      let calls = 0;
      try {
        await withRetry(
          async (attempt) => {
            calls += 1;
            assert.equal(attempt, 1);
            throw fromStatus('s', 'o', 503, attempt);
          },
          { method: 'POST', maxAttempts: 5, jitter: false, sleep: noSleep },
        );
        assert.fail('expected throw');
      } catch (err) {
        assert.ok(err instanceof ExternalServiceError);
      }
      assert.equal(calls, 1);
    },
  },
  {
    name: 'POST with allowNonIdempotentRetry retries like GET',
    run: async () => {
      let calls = 0;
      const res = await withRetry(
        async (attempt) => {
          calls += 1;
          if (attempt < 2) throw fromStatus('s', 'o', 429, attempt);
          return 'ok-post';
        },
        { method: 'POST', allowNonIdempotentRetry: true, jitter: false, sleep: noSleep },
      );
      assert.equal(res, 'ok-post');
      assert.equal(calls, 2);
    },
  },
  {
    name: '4xx (400/404) never retries — fails fast on attempt 1',
    run: async () => {
      for (const status of [400, 404]) {
        let calls = 0;
        try {
          await withRetry(
            async (attempt) => {
              calls += 1;
              throw fromStatus('s', 'o', status, attempt);
            },
            { maxAttempts: 4, jitter: false, sleep: noSleep },
          );
          assert.fail('expected throw');
        } catch (err) {
          assert.ok(err instanceof ExternalServiceError);
        }
        assert.equal(calls, 1, `status ${status} must not retry`);
      }
    },
  },
  {
    name: 'timeout retries then succeeds',
    run: async () => {
      let calls = 0;
      const res = await withRetry(
        async (attempt) => {
          calls += 1;
          if (attempt === 1) throw timeoutError('s', 'o', attempt);
          return 'recovered';
        },
        { maxAttempts: 3, jitter: false, sleep: noSleep },
      );
      assert.equal(res, 'recovered');
      assert.equal(calls, 2);
    },
  },
  {
    name: 'success on first try never sleeps',
    run: async () => {
      let slept = 0;
      const res = await withRetry(async () => 'fast', {
        sleep: () => {
          slept += 1;
          return Promise.resolve();
        },
      });
      assert.equal(res, 'fast');
      assert.equal(slept, 0);
    },
  },
];

let failed = 0;

async function main(): Promise<void> {
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
    console.error(`${failed}/${checks.length} retry checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`${checks.length}/${checks.length} retry checks passed`);
  }
}

void main();
