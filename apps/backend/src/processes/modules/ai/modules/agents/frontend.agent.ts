import { Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import { SessionRunnerService } from '../../../../../common/zen/session-runner.service';
import { ASK_FALLBACK_MODELS, isFailFastKeyError } from './model-fallback';

/** Domain system prompt for frontend tasks (sent as OpenAI-compatible system role). */
export const FRONTEND_SYSTEM =
  'Ты frontend-разработчик Rush Code (Next.js+React+kit @web2bizz/ui): делаешь компоненты, страницы, хуки и стили. Бэкенд не трогаешь.';

/**
 * Frontend agent — frontend tasks through the harness-owned runner
 * (SessionRunnerService, direct per-user Zen call behind the caller's
 * decrypted key). Same fallback chain / fail-fast / warn-log as AskAgent.
 */
@Injectable()
export class FrontendAgent {
  readonly id = 'frontend';
  readonly name = 'Frontend';
  readonly description = 'Frontend tasks: UI, components, pages';

  constructor(
    @Optional() private readonly runner?: SessionRunnerService,
    private readonly logger: AppLogger = new AppLogger(FrontendAgent.name),
  ) {}

  async ask(question: string, userId: string, correlationId?: string): Promise<string> {
    if (!this.runner) throw new Error('SessionRunnerService is not wired');
    this.logger.info('[agents] frontend via runner', correlationId);
    let lastErr: unknown;
    for (let i = 0; i < ASK_FALLBACK_MODELS.length; i++) {
      const model = ASK_FALLBACK_MODELS[i];
      try {
        return await this.runner.chat(userId, question, {
          model,
          system: FRONTEND_SYSTEM,
          correlationId,
        });
      } catch (err) {
        if (isFailFastKeyError(err)) throw err;
        lastErr = err;
        this.logger.warn(
          `[agents] frontend fallback model=${model} attempt=${i + 1}/${ASK_FALLBACK_MODELS.length}`,
          correlationId,
        );
      }
    }
    throw lastErr;
  }
}
