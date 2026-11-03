import { Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import { SessionRunnerService } from '../../../../../common/zen/session-runner.service';

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
    return this.runner.chat(userId, question, { correlationId });
  }
}
