import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { OpencodeHostService } from '../../../opencode/opencode-host.service';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { AssistantBuffer, HostBinding, TurnMeta } from '../../sessions.types';
import { SessionRuntimeStateService } from '../state/session-runtime-state.service';

/**
 * AssistantRecorderService — the single process-level host-event recorder.
 *
 * Subscribes to the embedded host bus once and persists assistant text into
 * `session_messages` so a reload keeps the answer even though the inbound
 * endpoint only answers the queued user receipt. Durable vs live (explicit):
 * only `session.text.*` assistant deltas become durable rows; reasoning
 * (`session.reasoning.*`) and tool lifecycle (`session.tool.*`) are live-only
 * SSE detail and are never written here.
 */
@Injectable()
export class AssistantRecorderService implements OnModuleInit, OnModuleDestroy {
  /** True when the single process-level assistant recorder is subscribed. */
  private recorderStarted: boolean = false;
  /** Single-flight guard for the recorder subscription. */
  private recorderStarting: Promise<void> | null = null;
  /** Cancels the recorder on module destroy. */
  private readonly recorderAbort: AbortController = new AbortController();
  /** Assistant text buffers keyed by `${hostSessionID}\u0000${assistantMessageID}`. */
  private readonly assistantBuffers: Map<string, AssistantBuffer> = new Map<
    string,
    AssistantBuffer
  >();

  constructor(
    private readonly host: OpencodeHostService,
    private readonly history: SessionHistoryRepository,
    private readonly state: SessionRuntimeStateService,
    private readonly logger: AppLogger = new AppLogger(AssistantRecorderService.name),
  ) {}

  onModuleInit(): void {
    // Best-effort: the host may still be booting; ensureStarted() is retried
    // from sendMessage/streamEvents.
    void this.ensureStarted();
  }

  onModuleDestroy(): void {
    this.recorderAbort.abort();
    this.recorderStarted = false;
    this.assistantBuffers.clear();
  }

  /**
   * Starts the single process-level host-event recorder (once). Retried by
   * the callers after boot so a late host never leaves it unsubscribed.
   */
  async ensureStarted(): Promise<void> {
    if (this.recorderStarted) return;
    this.recorderStarting ??= this.startAssistantRecorder();
    await this.recorderStarting;
  }

  private async startAssistantRecorder(): Promise<void> {
    try {
      const stream: AsyncIterable<unknown> = await this.host.subscribeEvents(
        this.recorderAbort.signal,
      );
      if (this.recorderAbort.signal.aborted) return;
      this.recorderStarted = true;
      void this.consumeHostEvents(stream);
    } catch (error) {
      if (!this.recorderAbort.signal.aborted) {
        this.logger.warn('[sessions] assistant recorder unavailable', '');
        this.logger.debug((error as Error).message, '');
      }
    } finally {
      this.recorderStarting = null;
    }
  }

  private async consumeHostEvents(stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.recorderAbort.signal.aborted) break;
        try {
          await this.recordHostEvent(event);
        } catch (error) {
          // One bad frame/DB write never kills the process-level recorder.
          this.logger.warn('[sessions] assistant persist failed', '');
          this.logger.debug((error as Error).message, '');
        }
      }
    } catch (error) {
      if (!this.recorderAbort.signal.aborted) {
        this.logger.warn('[sessions] assistant recorder stopped', '');
        this.logger.debug((error as Error).message, '');
      }
    } finally {
      this.recorderStarted = false;
    }
  }

  /**
   * Accumulate assistant text and persist it idempotently on turn end.
   *
   * Durable vs live (explicit): only `session.text.*` assistant deltas become
   * durable `session_messages` rows (reload-safe). Reasoning
   * (`session.reasoning.*`) and tool lifecycle (`session.tool.*`) are
   * live-only SSE detail — they ride `streamEvents` project-scoped but are
   * never written here, never invent a durable row, and vanish on reload.
   */
  private async recordHostEvent(event: unknown): Promise<void> {
    const frame: { type?: unknown; created?: unknown; data?: unknown } | null = event as {
      type?: unknown;
      created?: unknown;
      data?: unknown;
    } | null;
    const type: string = typeof frame?.type === 'string' ? frame.type : '';
    const data: Record<string, unknown> =
      frame && typeof frame.data === 'object' && frame.data !== null
        ? (frame.data as Record<string, unknown>)
        : {};
    const sessionID: string | undefined =
      typeof data.sessionID === 'string' ? data.sessionID : undefined;
    if (!sessionID) return;
    const assistantMessageID: string | undefined =
      typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined;
    const createdRaw: unknown = frame?.created;
    const createdAt: number =
      typeof createdRaw === 'number' && Number.isFinite(createdRaw) ? createdRaw : Date.now();

    if (
      type === 'session.reasoning.started' ||
      type === 'session.reasoning.delta' ||
      type === 'session.reasoning.ended' ||
      type === 'session.tool.called' ||
      type === 'session.tool.progress' ||
      type === 'session.tool.success' ||
      type === 'session.tool.failed' ||
      type === 'session.tool.input.started' ||
      type === 'session.tool.input.delta' ||
      type === 'session.tool.input.ended' ||
      type === 'session.text.started' ||
      type === 'session.step.started' ||
      type === 'session.step.streamed' ||
      type === 'session.step.failed' ||
      type === 'session.execution.started'
    ) {
      // Live-only detail: reasoning/thinking + tool lifecycle + turn markers
      // stream to the chat via SSE without loss, but never become durable
      // history. No buffer, no persist — reload shows the durable thread only.
      return;
    }

    if (type === 'session.text.delta') {
      const delta: string = typeof data.delta === 'string' ? data.delta : '';
      if (!assistantMessageID || delta.length === 0) return;
      const key: string = `${sessionID}\u0000${assistantMessageID}`;
      const buffer: AssistantBuffer = this.assistantBuffers.get(key) ?? {
        sessionID,
        assistantMessageID,
        text: '',
        createdAt,
      };
      buffer.text += delta;
      this.assistantBuffers.set(key, buffer);
      return;
    }

    if (type === 'session.text.ended') {
      if (!assistantMessageID) return;
      const key: string = `${sessionID}\u0000${assistantMessageID}`;
      const fullText: string = typeof data.text === 'string' ? data.text : '';
      const buffer: AssistantBuffer = this.assistantBuffers.get(key) ?? {
        sessionID,
        assistantMessageID,
        text: '',
        createdAt,
      };
      if (fullText.length > 0) buffer.text = fullText;
      this.assistantBuffers.set(key, buffer);
      await this.flushAssistant(key);
      return;
    }

    if (type === 'session.step.ended') {
      if (!assistantMessageID) return;
      await this.flushAssistant(`${sessionID}\u0000${assistantMessageID}`);
      return;
    }

    if (
      type === 'session.execution.succeeded' ||
      type === 'session.execution.failed' ||
      type === 'session.execution.interrupted'
    ) {
      const prefix: string = `${sessionID}\u0000`;
      for (const key of [...this.assistantBuffers.keys()]) {
        if (key.startsWith(prefix)) await this.flushAssistant(key);
      }
      const binding: HostBinding | undefined = await this.resolveHostBinding(sessionID);
      if (binding) this.state.deleteTurnMeta(binding.localSessionId);
    }
  }

  /** Idempotent: message id = host assistantMessageID (PK conflict = no-op). */
  private async flushAssistant(key: string): Promise<void> {
    const buffer: AssistantBuffer | undefined = this.assistantBuffers.get(key);
    if (!buffer) return;
    if (buffer.text.length === 0) {
      this.assistantBuffers.delete(key);
      return;
    }
    const binding: HostBinding | undefined = await this.resolveHostBinding(buffer.sessionID);
    if (!binding) {
      this.assistantBuffers.delete(key);
      return;
    }
    const turn: TurnMeta | undefined = this.state.getTurnMeta(binding.localSessionId);
    const userId: string | undefined = binding.userId ?? turn?.userId;
    if (!userId) {
      // Never invent an owner: without one the durable row cannot be honest.
      this.logger.warn('[sessions] assistant persist skipped code=no_owner', '');
      this.assistantBuffers.delete(key);
      return;
    }
    let agentId: string | null = turn?.agentId ?? null;
    if (!agentId) {
      try {
        agentId = (await this.history.getAgent(binding.localSessionId)) ?? null;
      } catch {
        agentId = null;
      }
    }
    await this.history.appendMessage({
      id: buffer.assistantMessageID,
      sessionId: binding.localSessionId,
      projectId: binding.projectId,
      userId,
      role: 'assistant',
      agentId,
      text: buffer.text,
      createdAt: new Date(buffer.createdAt).toISOString(),
    });
    this.assistantBuffers.delete(key);
  }

  /** Host id → durable binding, cached in-process (DB lookup on first sight). */
  private async resolveHostBinding(hostSessionId: string): Promise<HostBinding | undefined> {
    const cached: HostBinding | undefined = this.state.getHostBinding(hostSessionId);
    if (cached) return cached;
    const found:
      | { id: string; projectId: string; userId?: string }
      | undefined = await this.history.findSessionByHostSessionId(hostSessionId);
    if (!found) return undefined;
    const binding: HostBinding = {
      projectId: found.projectId,
      localSessionId: found.id,
      ...(found.userId !== undefined ? { userId: found.userId } : {}),
    };
    this.state.bindHostSession(hostSessionId, binding);
    return binding;
  }
}
