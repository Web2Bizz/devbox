/** Bounded retry policy of one model step (never an infinite loop). */
export type RetryPolicy = {
  attempts: number;
  delayMs: number;
  shouldRetry?: (error: unknown) => boolean;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  delayMs: 250,
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `run` at most `attempts` times. Only `shouldRetry` (default: all)
 * failures retry; the last error is rethrown unchanged. Delay is fixed —
 * the bounded attempt count, not backoff cleverness, is the protection.
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(policy.attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      const retryable = policy.shouldRetry ? policy.shouldRetry(err) : true;
      if (!retryable || attempt === attempts) break;
      await wait(policy.delayMs);
    }
  }
  throw lastError;
}
