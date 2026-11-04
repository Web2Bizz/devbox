import { HttpException } from '@nestjs/common';

/**
 * Shared ask fallback chain (user-ordered paid openai-compatible ids; the
 * runner default CLOUD_DEFAULT_MODEL is untouched and the runner is not
 * modified). First success wins; ask() signatures take no model from outside.
 *
 * Fail-fast rule (no iteration, rethrown as-is): 404 opencode_key_missing
 * and 401 opencode_key_invalid — the code/key pair is identical for every
 * model. Detected by HttpException status/code, never by message text.
 */
export const ASK_FALLBACK_MODELS: ReadonlyArray<string> = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'qwen3.8-max',
  'glm-5.3-flash',
];

/** Fail-fast signal: key state is model-independent, retrying cannot help. */
export function isFailFastKeyError(err: unknown): boolean {
  if (!(err instanceof HttpException)) return false;
  const status = err.getStatus();
  const res = err.getResponse() as unknown;
  const code =
    typeof res === 'object' && res !== null
      ? (res as { code?: unknown }).code
      : undefined;
  return (
    (status === 404 && code === 'opencode_key_missing') ||
    (status === 401 && code === 'opencode_key_invalid')
  );
}
