import { HttpException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  ExternalServiceError,
  fromUnknown,
} from '@common/external/external-error';
import { AppLogger } from '@common/logger';
import { SessionRunnerService } from '@common/zen/session-runner.service';
import { AgentsService } from '../../../agents/agents.service';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { SessionMessage } from '../../sessions.dto';
import type { SessionTurnInput } from '../../sessions.types';
import { isMissingKey } from '../../utils/session-errors';
import { SessionFrameBufferService } from '../events/session-frame-buffer.service';
import { SessionRuntimeStateService } from '../state/session-runtime-state.service';
import { TurnWorkspaceService } from '../workspace/turn-workspace.service';

/** Chunk size of the contract-narrowed delta frames. */
const SSE_CHUNK: number = 200;

/**
 * DirectTurnService — one direct agent turn (per-user Zen transport).
 *
 * The answer comes from the session's agent (AgentsService — sessions→agents
 * DI edge; the Ask agent answers through the harness-owned runner behind the
 * caller's key). Both turns land in the durable Postgres history and the token
 * frames stay in the live SSE buffer. A late answer after interrupt() is
 * dropped (the partial commit already belongs to stop()).
 */
@Injectable()
export class DirectTurnService {
  constructor(
    private readonly history: SessionHistoryRepository,
    private readonly workspace: TurnWorkspaceService,
    private readonly state: SessionRuntimeStateService,
    private readonly buffer: SessionFrameBufferService,
    @Optional() private readonly runner?: SessionRunnerService,
    @Optional() private readonly agents?: AgentsService,
    private readonly logger: AppLogger = new AppLogger(DirectTurnService.name),
  ) {}

  /** Persist the user turn, run the agent, persist and stream the answer. */
  async send(input: SessionTurnInput): Promise<SessionMessage> {
    const { userId, sessionId, body, directory, agentId, correlationId } = input;
    const runner: SessionRunnerService | undefined = this.runner;
    if (!runner) {
      throw new NotFoundException({
        code: 'opencode_key_missing',
        message: 'No OpenCode API key configured for this user',
      });
    }
    const agents: AgentsService | undefined = this.agents;
    if (!agents) throw new Error('AgentsService is not wired');
    await this.history.setAgent(sessionId, body.projectId, agentId);
    void body.model;
    const userParent: string | null = await this.history.resolveAppendParent(sessionId, body.parentId);
    const receipt: SessionMessage = {
      id: Bun.randomUUIDv7(),
      type: 'user',
      createdAt: new Date().toISOString(),
      text: body.text,
      parentId: userParent,
    };
    // Persist the user turn BEFORE the agent runs: an interrupt drops the
    // answer but the question already belongs to the durable thread.
    await this.history.appendMessage({
      id: receipt.id,
      sessionId,
      userId,
      role: 'user',
      agentId,
      text: body.text,
      createdAt: receipt.createdAt,
      parentId: userParent,
    });
    // Pre-turn tree for revert: the boundary message id keys it, so a later
    // stage() can restore exactly the state the turn started from.
    await this.workspace.captureBeforeTurn(directory, sessionId, receipt.id, correlationId);
    this.state.markBusy(sessionId);
    this.bufferDirectLifecycleStart(sessionId, receipt.id);
    const assistantId: string = Bun.randomUUIDv7();
    try {
      const answer: string = await agents.askQuestion(agentId, body.text, userId, correlationId);
      if (!this.state.isBusy(sessionId)) {
        this.logger.info('[sessions] direct answer dropped after interrupt', correlationId);
        return receipt;
      }
      const assistant: SessionMessage = {
        id: assistantId,
        type: 'assistant',
        createdAt: new Date().toISOString(),
        text: answer,
        parentId: receipt.id,
      };
      await this.history.appendMessage({
        id: assistant.id,
        sessionId,
        userId,
        role: 'assistant',
        agentId,
        text: answer,
        createdAt: assistant.createdAt,
        parentId: receipt.id,
      });
      this.bufferDirectFrames(sessionId, assistant);
      this.bufferDirectLifecycleEnd(sessionId, receipt.id);
      this.bufferDirectIdle(sessionId);
      this.logger.info('[sessions] prompt answered directly', correlationId);
      return receipt;
    } catch (error) {
      // Missing per-user key: the direct transport never started, so the
      // staged receipt is discarded — the host fallback owns the durable row.
      if (isMissingKey(error)) {
        await this.history.discardMessage(receipt.id);
        throw error;
      }
      if (error instanceof ExternalServiceError && error.service === 'db') throw error;
      this.logger.warn('[sessions] direct prompt failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      // Terminal frames so the SSE `sending` gate clears (same fixed text as
      // the in-process turn) — without them a failed direct turn hangs.
      this.bufferDirectFailed(sessionId);
      if (error instanceof HttpException) throw error;
      throw fromUnknown('zen', 'sessionPromptDirect', error);
    } finally {
      this.state.clearBusy(sessionId);
    }
  }

  /** Terminal failure frames for a died direct turn (fixed text, then idle). */
  private bufferDirectFailed(sessionId: string): void {
    const message: string = 'не удалось выполнить ход, повторите позже';
    this.buffer.push('session.execution.failed', { sessionID: sessionId, message });
    this.buffer.push('session.step.failed', { sessionID: sessionId, message });
    this.buffer.pushIdle(sessionId);
  }

  /**
   * Live-only reasoning markers for the direct runner (ask/text-only path):
   * Ask is an answer mode, NOT a tool — so this path emits NO
   * `session.tool.*` frames here (a `tool: '<agentId>'` frame would be a fake
   * tool call and would surface as `ask called/done` in the chat timeline).
   * The markers ride the same bounded frame buffer (project-scoped via
   * data.sessionID, filtered by streamEvents like text), never durable
   * history. Real readonly tool frames — when Ask gains bound tools — flow
   * through the same buffer with their REAL names (never the agent id) and
   * must stay visible; the text answer below is untouched by them.
   */
  private bufferDirectLifecycleStart(sessionId: string, parentId?: string | null): void {
    this.buffer.push('session.reasoning.started', {
      sessionID: sessionId,
      ...(parentId ? { parentId } : {}),
    });
  }

  /**
   * Closing marker for a completed direct turn (live-only, same scope as the
   * start marker above): reasoning end, before the terminal session.idle.
   * No `session.tool.*` here — see the start marker above. Never durable,
   * never chat text — the frontend projects reasoning to the live thinking
   * trace (thinking lives only until the text arrives).
   */
  private bufferDirectLifecycleEnd(sessionId: string, parentId?: string | null): void {
    this.buffer.push('session.reasoning.ended', {
      sessionID: sessionId,
      ...(parentId ? { parentId } : {}),
    });
  }

  /**
   * Terminal frame for a completed direct turn: the frontend useChat send()
   * finalizes (clears sending) only on session.idle.
   */
  private bufferDirectIdle(sessionId: string): void {
    this.buffer.push('session.idle', { sessionID: sessionId });
  }

  /**
   * Chunk a direct answer into contract-narrowed token frames (delta slices +
   * the absolute snapshot) for the SSE buffer. The frontend already parses
   * exactly these two variants (useChat frameText) — no client change.
   */
  private bufferDirectFrames(sessionId: string, assistant: SessionMessage): void {
    const text: string = assistant.text ?? '';
    if (!text) return;
    const partID: string = `prt_${assistant.id}`;
    const parentId: string | null | undefined = assistant.parentId ?? undefined;
    for (let index: number = 0; index < text.length; index += SSE_CHUNK) {
      this.buffer.push('message.part.delta', {
        sessionID: sessionId,
        messageID: assistant.id,
        partID,
        field: 'text',
        delta: text.slice(index, index + SSE_CHUNK),
        ...(parentId ? { parentId } : {}),
      });
    }
    this.buffer.push('message.part.updated', {
      sessionID: sessionId,
      ...(parentId ? { parentId } : {}),
      part: { id: partID, type: 'text', text },
    });
  }
}
