import { Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import { SessionRunnerService } from '../../../../../common/zen/session-runner.service';
import { ASK_FALLBACK_MODELS, isFailFastKeyError } from './model-fallback';

/** Domain system prompt for backend tasks (sent as OpenAI-compatible system role). */
export const BACKEND_SYSTEM =
  'Ты backend-разработчик Rush Code (NestJS+TS+Drizzle+Zod): проектируешь API, сервисы, БД, миграции и контракты границы. Про фронт и вёрстку не рассуждаешь. Результат — файлы в workspace проекта плюс краткая сводка; ответ только в markdown без файлов запрещён.';

/**
 * Backend agent — backend tasks through the harness-owned runner
 * (SessionRunnerService, direct per-user Zen call behind the caller's
 * decrypted key). Same fallback chain / fail-fast / warn-log as AskAgent.
 */
@Injectable()
export class BackendAgent {
  readonly id = 'backend';
  readonly name = 'Backend';
  readonly description = 'Backend tasks: API, services, database';

  constructor(
    @Optional() private readonly runner?: SessionRunnerService,
    private readonly logger: AppLogger = new AppLogger(BackendAgent.name),
  ) {}

  async ask(question: string, userId: string, correlationId?: string): Promise<string> {
    if (!this.runner) throw new Error('SessionRunnerService is not wired');
    this.logger.info('[agents] backend via runner', correlationId);
    let lastErr: unknown;
    for (let i = 0; i < ASK_FALLBACK_MODELS.length; i++) {
      const model = ASK_FALLBACK_MODELS[i];
      try {
        return await this.runner.chat(userId, question, {
          model,
          system: BACKEND_SYSTEM,
          correlationId,
        });
      } catch (err) {
        if (isFailFastKeyError(err)) throw err;
        lastErr = err;
        this.logger.warn(
          `[agents] backend fallback model=${model} attempt=${i + 1}/${ASK_FALLBACK_MODELS.length}`,
          correlationId,
        );
      }
    }
    throw lastErr;
  }
}
