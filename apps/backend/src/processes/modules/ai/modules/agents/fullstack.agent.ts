import { Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import { SessionRunnerService } from '../../../../../common/zen/session-runner.service';
import { ASK_FALLBACK_MODELS, isFailFastKeyError } from './model-fallback';

/** Domain system prompt for end-to-end tasks (sent as OpenAI-compatible system role). */
export const FULLSTACK_SYSTEM =
  'Ты fullstack-разработчик Rush Code: связываешь фронт и бэк через контракты, ведёшь сквозные задачи в порядке бэк, контракт, фронт. Результат — файлы в workspace проекта плюс краткая сводка; ответ только в markdown без файлов запрещён.';

/**
 * Fullstack agent — end-to-end tasks through the harness-owned runner
 * (SessionRunnerService, direct per-user Zen call behind the caller's
 * decrypted key). Same fallback chain / fail-fast / warn-log as AskAgent.
 */
@Injectable()
export class FullstackAgent {
  readonly id = 'fullstack';
  readonly name = 'Fullstack';
  readonly description = 'End-to-end tasks across frontend and backend';

  constructor(
    @Optional() private readonly runner?: SessionRunnerService,
    private readonly logger: AppLogger = new AppLogger(FullstackAgent.name),
  ) {}

  async ask(question: string, userId: string, correlationId?: string): Promise<string> {
    if (!this.runner) throw new Error('SessionRunnerService is not wired');
    this.logger.info('[agents] fullstack via runner', correlationId);
    let lastErr: unknown;
    for (let i = 0; i < ASK_FALLBACK_MODELS.length; i++) {
      const model = ASK_FALLBACK_MODELS[i];
      try {
        return await this.runner.chat(userId, question, {
          model,
          system: FULLSTACK_SYSTEM,
          correlationId,
        });
      } catch (err) {
        if (isFailFastKeyError(err)) throw err;
        lastErr = err;
        this.logger.warn(
          `[agents] fullstack fallback model=${model} attempt=${i + 1}/${ASK_FALLBACK_MODELS.length}`,
          correlationId,
        );
      }
    }
    throw lastErr;
  }
}
