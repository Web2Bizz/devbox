import { HttpException, Injectable } from '@nestjs/common';
import type { ToolView } from '@rush-code/contracts';
import type { CryptoService } from '@common/crypto/crypto.service';
import {
  ExternalServiceError,
  fromUnknown,
} from '@common/external/external-error';
import { AppLogger } from '@common/logger';
import type { VaultService } from '@common/vault/vault.service';
import type { OpencodeModelFetch } from '../../../opencode/opencode-model-fetch';
import {
  InMemoryToolEffectsStore,
  ToolDispatchService,
} from '../../../tool-dispatch/tool-dispatch.service';
import { ToolRegistryService } from '../../../tool-registry/tool-registry.service';
import type { ToolMode } from '../../../tool-runtime/tool-runtime.types';
import {
  createLangChainTools,
  filterLangChainToolsForMode,
  type LangChainToolBinding,
} from '../../../tools/utils/langchain-tools/langchain-tools.util';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { SessionMessage } from '../../sessions.dto';
import type { SessionTurnInput } from '../../sessions.types';
import { isMissingKey } from '../../utils/session-errors';
import { SessionFrameBufferService } from '../events/session-frame-buffer.service';
import {
  createStepExecutor,
  SessionTurnRunnerService,
  type StepExecutor,
} from '../runner/runner.service';
import type { TurnFrame } from '../runner/loop';
import { SessionRuntimeStateService } from '../state/session-runtime-state.service';
import { TurnWorkspaceService } from '../workspace/turn-workspace.service';

/** Chunk size of the contract-narrowed delta frames. */
const SSE_CHUNK: number = 200;

/** Fixed, secret-free failure text of the terminal frames (never a stack). */
export const IN_PROCESS_FAILED_MESSAGE: string = 'не удалось выполнить ход, повторите позже';

/**
 * System prompt of the in-process auto turn: the model works only through the
 * LangChain tools of the project, and the visible result is the workspace.
 */
const AUTO_SYSTEM_PROMPT: string =
  'Ты — Auto-режим Rush Code. Работай в workspace проекта только через инструменты: читай и ищи файлы, правь их и запускай команды. Результат — реальные файлы проекта плюс краткая сводка сделанного.';

/** Native views travel to the dispatcher under their bare registry name. */
function nativeWireName(view: ToolView): string {
  return view.id.startsWith('native:') ? view.id.slice('native:'.length) : view.id;
}

/**
 * InProcessTurnService — the `auto` turn executed by rush-code itself.
 *
 * The model answers through the shared chain router (LangChain tools bound by
 * mode), tool calls settle through `ToolDispatchService` in the runner loop,
 * and the files are really written (the turn runs in the gated project
 * directory, the pre-turn tree is captured for revert). The embedded host is
 * NOT prompted: `auto` no longer depends on a bound host session.
 *
 * Durable vs live (explicit): only the user receipt and the assistant TEXT
 * land in Postgres; reasoning/tool/step frames are live-only in the bounded
 * SSE buffer. A late answer after interrupt() is dropped (the partial commit
 * already belongs to stop()), and the busy marker is always cleared.
 */
@Injectable()
export class InProcessTurnService {
  constructor(
    private readonly history: SessionHistoryRepository,
    private readonly workspace: TurnWorkspaceService,
    private readonly state: SessionRuntimeStateService,
    private readonly buffer: SessionFrameBufferService,
    private readonly runner: SessionTurnRunnerService,
    private readonly registry: ToolRegistryService,
    private readonly dispatch: ToolDispatchService,
    private readonly keys: VaultService,
    private readonly crypto: CryptoService,
    private readonly opencodeFetch: OpencodeModelFetch,
    private readonly logger: AppLogger = new AppLogger(InProcessTurnService.name),
  ) {}

  /** Persist the user turn, run the model loop, persist and stream the answer. */
  async send(input: SessionTurnInput): Promise<SessionMessage> {
    const { userId, sessionId, body, directory, agentId, correlationId } = input;
    const mode: ToolMode = body.mode ?? 'auto';
    await this.history.setAgent(sessionId, body.projectId, agentId);
    const receipt: SessionMessage = {
      id: Bun.randomUUIDv7(),
      type: 'user',
      createdAt: new Date().toISOString(),
      text: body.text,
    };
    // The question belongs to the durable thread before the model runs: an
    // interrupt drops the answer, never the question.
    await this.history.appendMessage({
      id: receipt.id,
      sessionId,
      projectId: body.projectId,
      userId,
      role: 'user',
      agentId,
      text: body.text,
      createdAt: receipt.createdAt,
    });
    await this.workspace.captureBeforeTurn(directory, sessionId, receipt.id, correlationId);
    this.state.markBusy(sessionId);
    this.state.setTurnMeta(sessionId, { userId, projectId: body.projectId, agentId, mode });
    this.bufferStart(sessionId);
    const assistantId: string = Bun.randomUUIDv7();
    try {
      const step: StepExecutor = this.buildStep({
        userId,
        sessionId,
        directory,
        mode,
        correlationId,
      });
      const result = await this.runner.runTurn({
        sessionId,
        directory,
        messages: [{ role: 'user', content: body.text }],
        step,
        runId: receipt.id,
        effects: new InMemoryToolEffectsStore(),
        mode,
        publish: (frame: TurnFrame) => this.publishFrame(sessionId, assistantId, frame),
        correlationId,
      });
      if (!this.state.isBusy(sessionId)) {
        this.logger.info('[sessions] in-process answer dropped after interrupt', correlationId);
        return receipt;
      }
      // Durable history keeps TEXT only: tool/reasoning frames stay live.
      await this.history.appendMessage({
        id: assistantId,
        sessionId,
        projectId: body.projectId,
        userId,
        role: 'assistant',
        agentId,
        text: result.text,
        createdAt: new Date().toISOString(),
      });
      this.logger.info(
        `[sessions] in-process turn done steps=${result.steps} tools=${result.settlements.length} mode=${mode}`,
        correlationId,
      );
      return receipt;
    } catch (error) {
      // Missing per-user key: the turn never started — the staged receipt is
      // discarded and the honest 404 travels outward (no host fallback).
      if (isMissingKey(error)) {
        await this.history.discardMessage(receipt.id);
        throw error;
      }
      // Postgres outage: never mask it as a model failure.
      if (error instanceof ExternalServiceError && error.service === 'db') throw error;
      this.logger.warn('[sessions] in-process turn failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      this.bufferFailed(sessionId);
      if (error instanceof HttpException) throw error;
      throw fromUnknown('zen', 'sessionPromptInProcess', error);
    } finally {
      this.state.clearBusy(sessionId);
    }
  }

  /**
   * Builds the model step of the turn: the registry's ToolView catalog is
   * bound to LangChain tools, filtered by mode (`ask` = read-only), and the
   * chain executor is created over the caller's per-user keys.
   *
   * Protected so a spec can answer a fake executor without a model call.
   */
  protected buildStep(input: {
    userId: string;
    sessionId: string;
    directory: string;
    mode: ToolMode;
    correlationId: string;
  }): StepExecutor {
    const views: Array<ToolView> = this.registry.listViews();
    const bindings: Array<LangChainToolBinding> = createLangChainTools(
      views,
      {
        dispatch: (calls, context, concurrency, effects) =>
          this.dispatch.dispatch(calls, context, concurrency, effects),
        context: { directory: input.directory, sessionId: input.sessionId, mode: input.mode },
      },
      { wireNameFor: nativeWireName },
    );
    const allowed: Array<LangChainToolBinding> = filterLangChainToolsForMode(
      bindings,
      input.mode,
    );
    return createStepExecutor({
      userId: input.userId,
      system: AUTO_SYSTEM_PROMPT,
      tools: allowed.map((binding) => binding.tool),
      toolChoiceFromRequest: (request) => request.toolChoice,
      keys: this.keys,
      crypto: this.crypto,
      opencodeFetch: this.opencodeFetch,
      correlationId: input.correlationId,
    });
  }

  /**
   * Start frames of the turn. `session.step.started` is emitted by the
   * runner's `step-start` publish (one per step), so it is not duplicated
   * here; the execution/reasoning markers open the live trace.
   */
  private bufferStart(sessionId: string): void {
    this.buffer.push('session.execution.started', { sessionID: sessionId });
    this.buffer.push('session.reasoning.started', { sessionID: sessionId });
  }

  /**
   * Runner frame → domain SSE frame. Everything is live-only and guarded by
   * the busy marker: an interrupted turn drops its late frames (no phantom
   * text/terminator), while the durable question row stays.
   */
  private publishFrame(sessionId: string, assistantId: string, frame: TurnFrame): void {
    if (!this.state.isBusy(sessionId)) return;
    if (frame.type === 'step-start') {
      this.buffer.push('session.step.started', { sessionID: sessionId });
      return;
    }
    if (frame.type === 'tool-result') {
      const result: string = typeof frame.data.result === 'string' ? frame.data.result : '';
      const tool: string = typeof frame.data.name === 'string' ? frame.data.name : 'tool';
      const failed: boolean = result.startsWith('error:');
      this.buffer.push(failed ? 'session.tool.failed' : 'session.tool.success', {
        sessionID: sessionId,
        tool,
        ...(failed ? { error: result } : {}),
      });
      return;
    }
    if (frame.type === 'step-finish') {
      this.buffer.push('session.step.streamed', { sessionID: sessionId });
      return;
    }
    if (frame.type === 'finish') {
      const text: string = typeof frame.data.text === 'string' ? frame.data.text : '';
      this.bufferTextFrames(sessionId, assistantId, text);
      this.buffer.push('session.text.ended', { sessionID: sessionId, text });
      this.buffer.push('session.execution.succeeded', { sessionID: sessionId });
      this.buffer.push('session.step.ended', { sessionID: sessionId });
      this.buffer.pushIdle(sessionId);
    }
  }

  /** Chunk the assistant answer into delta frames + the absolute snapshot. */
  private bufferTextFrames(sessionId: string, assistantId: string, text: string): void {
    if (!text) return;
    const partID: string = `prt_${assistantId}`;
    for (let index: number = 0; index < text.length; index += SSE_CHUNK) {
      this.buffer.push('message.part.delta', {
        sessionID: sessionId,
        messageID: assistantId,
        partID,
        field: 'text',
        delta: text.slice(index, index + SSE_CHUNK),
      });
    }
    this.buffer.push('message.part.updated', {
      sessionID: sessionId,
      part: { id: partID, type: 'text', text },
    });
  }

  /** Terminal failure frames (fixed text, then the idempotent idle). */
  private bufferFailed(sessionId: string): void {
    this.buffer.push('session.execution.failed', {
      sessionID: sessionId,
      message: IN_PROCESS_FAILED_MESSAGE,
    });
    this.buffer.push('session.step.failed', {
      sessionID: sessionId,
      message: IN_PROCESS_FAILED_MESSAGE,
    });
    this.buffer.pushIdle(sessionId);
  }
}
