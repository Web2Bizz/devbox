import { Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { SessionRunnerService } from '@common/zen/session-runner.service';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { SendMessageInput, SessionMessage } from '../../sessions.dto';
import { isMissingKey } from '../../utils/session-errors';
import { DirectTurnService } from './direct-turn.service';
import { FileCommandTurnService } from './file-command.turn';
import { HostTurnService } from './host-turn.service';
import { InProcessTurnService } from './in-process-turn.service';

/**
 * SessionMessagingService — transport selection for one message turn.
 *
 * Mirrors the harness `sendMessage` chain after the C4 gate:
 * 1. deterministic jailed file/shell commands answer first (no model
 *    round-trip);
 * 2. the `auto` agent executes IN PROCESS (D1): the rush-code model chain +
 *    LangChain tools really write the project files, so auto no longer needs
 *    a bound host session and its per-user key is the only requirement;
 * 3. otherwise a stored per-user key answers through the direct runner
 *    (no host prompt needed); without a key (404 `opencode_key_missing`) the
 *    bound host session owns the turn.
 *
 * The host turn stays as the LEGACY path only (ask without a key); it is
 * never selected for `auto`.
 *
 * The user receipt is persisted in the durable thread on every path.
 */
@Injectable()
export class SessionMessagingService {
  constructor(
    private readonly history: SessionHistoryRepository,
    private readonly fileTurn: FileCommandTurnService,
    private readonly directTurn: DirectTurnService,
    private readonly hostTurn: HostTurnService,
    private readonly inProcess: InProcessTurnService,
    @Optional() private readonly runner?: SessionRunnerService,
    private readonly logger: AppLogger = new AppLogger(SessionMessagingService.name),
  ) {}

  /** Route one message to the file bridge, the direct runner, or the host. */
  async send(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    directory: string,
    explicitAgentId: string | undefined,
    correlationId: string,
  ): Promise<SessionMessage> {
    const agentId: string = explicitAgentId ?? (await this.history.getAgent(sessionId)) ?? 'ask';
    // Jailed project-file commands first (deterministic, no model round-trip).
    // Null = not a file command — fall through to the transports below.
    const fileTurnResult: SessionMessage | null = await this.fileTurn.tryHandle({
      userId,
      sessionId,
      body,
      directory,
      agentId,
      correlationId,
    });
    if (fileTurnResult) return fileTurnResult;
    // D1 auto→in-process: the auto agent runs on the rush-code model chain with
    // LangChain tools, so the turn really touches the project workspace. A
    // missing per-user key is an honest 404 here — never a silent host fallback.
    if (agentId === 'auto') {
      this.logger.info('[sessions] auto in-process', correlationId);
      return this.inProcess.send({ userId, sessionId, body, directory, agentId, correlationId });
    }
    // Transport selection (explicit, user-sanctioned): a stored per-user Zen
    // key answers through the direct runner (no host prompt needed); without
    // a key (404 opencode_key_missing) the bound host session owns the turn.
    if (this.runner) {
      try {
        return await this.directTurn.send({
          userId,
          sessionId,
          body,
          directory,
          agentId,
          correlationId,
        });
      } catch (error) {
        if (!isMissingKey(error)) throw error;
        this.logger.warn('[sessions] direct runner skipped code=opencode_key_missing', correlationId);
      }
    }
    return this.hostTurn.send({ userId, sessionId, body, directory, agentId, correlationId });
  }
}
