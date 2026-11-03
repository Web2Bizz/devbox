import { HttpException, Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import { SessionRunnerService } from '../../../../../common/zen/session-runner.service';

/**
 * Ask fallback chain (user-ordered paid openai-compatible ids; only Ask —
 * the runner default CLOUD_DEFAULT_MODEL is untouched and the runner is not
 * modified). First success wins; the ask() signature takes no model from
 * outside.
 *
 * Fail-fast rule (no iteration, rethrown as-is): 404 opencode_key_missing
 * and 401 opencode_key_invalid — the code/key pair is identical for every
 * model. Detected by HttpException status/code, never by message text.
 */
const ASK_FALLBACK_MODELS: ReadonlyArray<string> = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'qwen3.8-max',
  'glm-5.3-flash',
];

/** Fail-fast signal: key state is model-independent, retrying cannot help. */
function isFailFastKeyError(err: unknown): boolean {
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

/**
 * Ask agent — answers user questions through the harness-owned runner
 * (SessionRunnerService, direct per-user Zen call behind the caller's
 * decrypted key). No mock answers: without a stored key the runner throws
 * the honest 404 opencode_key_missing (same code as billing), undecryptable
 * rows 500 via CryptoService, rejected keys 401 opencode_key_invalid.
 */
@Injectable()
export class AskAgent {
  readonly id = 'ask';
  readonly name = 'Ask';
  readonly description = 'Answers user questions';

  constructor(
    @Optional() private readonly runner?: SessionRunnerService,
    private readonly logger: AppLogger = new AppLogger(AskAgent.name),
  ) {}

  async ask(question: string, userId: string, correlationId?: string): Promise<string> {
    if (!this.runner) throw new Error('SessionRunnerService is not wired');
    this.logger.info('[agents] ask via runner', correlationId);
    let lastErr: unknown;
    for (let i = 0; i < ASK_FALLBACK_MODELS.length; i++) {
      const model = ASK_FALLBACK_MODELS[i];
      try {
        return await this.runner.chat(userId, question, { model, correlationId });
      } catch (err) {
        if (isFailFastKeyError(err)) throw err;
        lastErr = err;
        this.logger.warn(
          `[agents] ask fallback model=${model} attempt=${i + 1}/${ASK_FALLBACK_MODELS.length}`,
          correlationId,
        );
      }
    }
    throw lastErr;
  }
}
