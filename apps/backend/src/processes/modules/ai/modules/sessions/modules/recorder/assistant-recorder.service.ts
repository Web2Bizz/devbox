import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { OpencodeHostService } from '../../../opencode/opencode-host.service';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { AssistantBuffer, HostBinding, TurnMeta } from '../../sessions.types';
import { SessionRuntimeStateService } from '../state/session-runtime-state.service';

/**
 * AssistantRecorderService — the single process-level host-event recorder.
 *
 * Subscribes to the embedded host bus once and persists the turn into
 * `session_messages` so a reload keeps the full chain even though the inbound
 * endpoint only answers the queued user receipt. Durable chain (0012):
 * `session.text.*` assistant deltas buffer into one text row, every
 * `session.tool.called/progress/tool input success/failed` appends one kind=tool
 * row immediately (parent=tip, tip=prev-link ?? receipt ?? tail), and
 * `session.reasoning.*` buffers into one kind=reasoning link — linked
 * receipt → tool/reasoning → assistant (the file-command/in-process shape),
 * so reload refetches the same chain. Idempotent by frame id
 * (domain_id onConflictDoNothing + tip dedupe): a redelivered frame reuses
 * its envelope id and never rewinds the tip. Detail is a single-line
 * 500-char snippet with secret redaction, never full payloads. Live-only
 * (never durable, SSE only): turn markers without stable call identity
 * (`session.text.started`, `session.step.started/streamed/failed`,
 * `session.execution.*`) — nothing honest to persist.
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
  /**
   * Chain tip per local session: id of the last durable tool/reasoning link
   * of the open turn. Reset on `session.execution.started`, cleared on the
   * terminal execution frame. The next link parents to the tip (linked
   * receipt → tool/reasoning → assistant), never a sibling under the
   * receipt. The closing assistant reads the tip but never extends it.
   */
  private readonly chainTips: Map<string, string> = new Map<string, string>();
  /**
   * Persisted tool frame ids (envelope `id` when the host supplies one):
   * a redelivered broadcast reuses its domain id (onConflictDoNothing) and
   * must never rewind the tip — the second sighting is a no-op.
   */
  private readonly persistedToolFrameIds: Set<string> = new Set<string>();

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
    this.reasoningBuffers.clear();
    this.chainTips.clear();
    this.persistedToolFrameIds.clear();
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
   * Durable chain (0012): `session.text.*` assistant deltas buffer into one
   * durable text row closing the turn; `session.tool.called/progress/
   * tool input success/failed` append one kind=tool link each immediately and
   * `session.reasoning.*` buffers into one kind=reasoning link — all linked
   * receipt → …tool/reasoning… → assistant (prev-link ?? receipt ?? tail,
   * the file-command/in-process shape). Reload refetches the same chain —
   * no live-only loss. Only turn markers without stable identity stay
   * live-only (never invented): `session.text.started`,
   * `session.step.started/streamed`, `session.execution.*` control frames.
   * Reasoning flushes before any terminal throw/abort (`step.failed`,
   * `step.ended`, `execution.succeeded/failed/interrupted`) so
   * max-steps/stop/interrupt never lose the buffered thinking.
   */
  private async recordHostEvent(event: unknown): Promise<void> {
    const frame: { id?: unknown; type?: unknown; created?: unknown; data?: unknown } | null =
      event as {
        id?: unknown;
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
    const frameId: string | undefined = this.frameIdOf(frame, data);

    if (type === 'session.execution.started') {
      // New turn on this host session: the next durable link parents to the
      // turn receipt again, not to the previous turn's closing assistant.
      // Cached binding only — never a DB lookup for a live-only marker.
      const cached: HostBinding | undefined = this.state.getHostBinding(sessionID);
      if (cached) this.chainTips.delete(cached.localSessionId);
      return;
    }

    if (
      type === 'session.text.started' ||
      type === 'session.step.started' ||
      type === 'session.step.streamed'
    ) {
      // Live-only turn markers without stable call identity: stream via SSE,
      // never durable (nothing honest to persist).
      return;
    }

    if (type === 'session.step.failed') {
      // Terminal throw/abort marker: flush the buffered thinking before the
      // turn dies so max-steps/stop/interrupt never lose the reasoning link.
      // The marker itself stays live-only (no stable identity, no row).
      const prefix: string = `${sessionID}\u0000`;
      for (const key of [...this.reasoningBuffers.keys()]) {
        if (key.startsWith(prefix)) await this.flushReasoning(key);
      }
      return;
    }

    if (
      type === 'session.reasoning.started' ||
      type === 'session.reasoning.delta' ||
      type === 'session.reasoning.ended'
    ) {
      await this.recordReasoningEvent(sessionID, assistantMessageID, type, data, createdAt);
      return;
    }

    if (
      type === 'session.tool.called' ||
      type === 'session.tool.progress' ||
      type === 'session.tool.input.started' ||
      type === 'session.tool.input.delta' ||
      type === 'session.tool.input.ended' ||
      type === 'session.tool.success' ||
      type === 'session.tool.failed'
    ) {
      await this.recordToolEvent(sessionID, type, data, frameId);
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
      // Reasoning first (same order as the execution terminators): the
      // buffered thinking link lands before the closing assistant so a
      // step-end throw/abort never loses it.
      const prefix: string = `${sessionID}\u0000`;
      for (const key of [...this.reasoningBuffers.keys()]) {
        if (key.startsWith(prefix)) await this.flushReasoning(key);
      }
      await this.flushAssistant(`${sessionID}\u0000${assistantMessageID}`);
      return;
    }

    if (
      type === 'session.execution.succeeded' ||
      type === 'session.execution.failed' ||
      type === 'session.execution.interrupted'
    ) {
      const prefix: string = `${sessionID}\u0000`;
      // Reasoning first so the buffered thinking link lands before the
      // closing assistant (receipt → …tool/reasoning… → assistant).
      for (const key of [...this.reasoningBuffers.keys()]) {
        if (key.startsWith(prefix)) await this.flushReasoning(key);
      }
      for (const key of [...this.assistantBuffers.keys()]) {
        if (key.startsWith(prefix)) await this.flushAssistant(key);
      }
      const binding: HostBinding | undefined = await this.resolveHostBinding(sessionID);
      if (binding) {
        // Host turn terminator: the POST returned long ago, so the busy
        // marker (set by HostTurnService) clears only here — statusMap,
        // the stream busy gate and interrupt() stay honest while streaming.
        this.state.clearBusy(binding.localSessionId);
        this.chainTips.delete(binding.localSessionId);
        this.state.deleteTurnMeta(binding.localSessionId);
      }
    }
  }

  /** Reasoning text buffers keyed like the assistant buffers (flush on ended). */
  private readonly reasoningBuffers: Map<string, AssistantBuffer> = new Map<
    string,
    AssistantBuffer
  >();

  /**
   * Linked-chain parent for the next durable link of a turn: the previous
   * tool/reasoning link when this turn already wrote one, else the turn
   * receipt, else the linear clock tail (turn meta gone — restart or an old
   * test harness). Never invents a parent.
   */
  private async resolveChainParent(
    sessionId: string,
    receiptId: string | undefined,
  ): Promise<string | null> {
    const tip: string | undefined = this.chainTips.get(sessionId);
    if (tip) return tip;
    if (receiptId !== undefined && receiptId.length > 0) return receiptId;
    return this.history.findTailId(sessionId);
  }

  /**
   * Reasoning chain link: buffer started/delta, flush one kind=reasoning row
   * on ended (parent=prev-link ?? receipt ?? tail — the file-command shape).
   * Never invents text — empty traces write nothing.
   */
  private async recordReasoningEvent(
    sessionID: string,
    assistantMessageID: string | undefined,
    type: string,
    data: Record<string, unknown>,
    createdAt: number,
  ): Promise<void> {
    const key: string = `${sessionID}\u0000${assistantMessageID ?? 'reasoning'}`;
    if (type === 'session.reasoning.started') {
      if (!this.reasoningBuffers.has(key)) {
        this.reasoningBuffers.set(key, { sessionID, assistantMessageID: key, text: '', createdAt });
      }
      return;
    }
    if (type === 'session.reasoning.delta') {
      const delta: string = typeof data.delta === 'string' ? data.delta : '';
      const text: string = typeof data.text === 'string' ? data.text : '';
      const chunk: string = delta.length > 0 ? delta : text;
      if (chunk.length === 0) return;
      const buffer: AssistantBuffer = this.reasoningBuffers.get(key) ?? {
        sessionID,
        assistantMessageID: key,
        text: '',
        createdAt,
      };
      buffer.text += chunk;
      this.reasoningBuffers.set(key, buffer);
      return;
    }
    const fullText: string = typeof data.text === 'string' ? data.text : '';
    const buffer: AssistantBuffer = this.reasoningBuffers.get(key) ?? {
      sessionID,
      assistantMessageID: key,
      text: '',
      createdAt,
    };
    if (fullText.length > 0) buffer.text = fullText;
    this.reasoningBuffers.set(key, buffer);
    await this.flushReasoning(key);
  }

  /** Flush one reasoning row (kind=reasoning, parent=prev-link ?? receipt ?? tail). */
  private async flushReasoning(key: string): Promise<void> {
    const buffer: AssistantBuffer | undefined = this.reasoningBuffers.get(key);
    if (!buffer) return;
    if (buffer.text.length === 0) {
      this.reasoningBuffers.delete(key);
      return;
    }
    const binding: HostBinding | undefined = await this.resolveHostBinding(buffer.sessionID);
    if (!binding) {
      this.reasoningBuffers.delete(key);
      return;
    }
    const turn: TurnMeta | undefined = this.state.getTurnMeta(binding.localSessionId);
    const userId: string | undefined = binding.userId ?? turn?.userId;
    if (!userId) {
      this.logger.warn('[sessions] reasoning persist skipped code=no_owner', '');
      this.reasoningBuffers.delete(key);
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
    const receiptParent: string | null | undefined = turn?.receiptId;
    const receiptId: string | undefined =
      receiptParent !== undefined && receiptParent !== null && receiptParent.length > 0
        ? receiptParent
        : undefined;
    const parentId: string | null = await this.resolveChainParent(
      binding.localSessionId,
      receiptId,
    );
    const reasoningId: string = Bun.randomUUIDv7();
    const safeDetail: string | null = this.toSafeDetail(buffer.text);
    await this.history.appendMessage({
      id: reasoningId,
      sessionId: binding.localSessionId,
      userId,
      role: 'reasoning',
      agentId,
      text: buffer.text.slice(0, 8000),
      createdAt: new Date(buffer.createdAt).toISOString(),
      parentId,
      kind: 'reasoning',
      name: 'reasoning',
      status: 'ended',
      ...(safeDetail !== null ? { detail: safeDetail } : {}),
    });
    this.chainTips.set(binding.localSessionId, reasoningId);
    this.reasoningBuffers.delete(key);
  }

  /**
   * Tool chain link: one kind=tool row per called/progress/tool input success/
   * failed, immediately (parent=prev-link ?? receipt ?? tail — the
   * file-command shape). Name/status/detail come from the real frame —
   * never invented; unknown names fall back to 'tool'. Idempotent by frame
   * id: a redelivered envelope reuses its domain id (onConflictDoNothing)
   * and never rewinds the tip (seen-set dedupe).
   */
  private async recordToolEvent(
    sessionID: string,
    type: string,
    data: Record<string, unknown>,
    frameId?: string,
  ): Promise<void> {
    if (frameId !== undefined && this.persistedToolFrameIds.has(frameId)) return;
    const binding: HostBinding | undefined = await this.resolveHostBinding(sessionID);
    if (!binding) return;
    const turn: TurnMeta | undefined = this.state.getTurnMeta(binding.localSessionId);
    const userId: string | undefined = binding.userId ?? turn?.userId;
    if (!userId) {
      this.logger.warn('[sessions] tool persist skipped code=no_owner', '');
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
    const rawName: unknown = data.tool ?? data.toolName ?? data.name;
    const name: string = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'tool';
    const status: string =
      type === 'session.tool.called'
        ? 'called'
        : type === 'session.tool.progress'
          ? 'progress'
          : type === 'session.tool.input.started' ||
              type === 'session.tool.input.delta' ||
              type === 'session.tool.input.ended'
            ? 'input'
            : type === 'session.tool.success'
              ? 'done'
              : 'failed';
    const detail: string | null = this.toSafeDetail(
      data.message ??
        data.progress ??
        data.status ??
        data.text ??
        data.error ??
        data.delta ??
        data.input ??
        data.arguments ??
        null,
    );
    const receiptParent: string | null | undefined = turn?.receiptId;
    const receiptId: string | undefined =
      receiptParent !== undefined && receiptParent !== null && receiptParent.length > 0
        ? receiptParent
        : undefined;
    const parentId: string | null = await this.resolveChainParent(
      binding.localSessionId,
      receiptId,
    );
    // Idempotent domain id: the host envelope id when present (redelivery =
    // onConflictDoNothing no-op), otherwise a fresh uuid (old harnesses).
    const toolId: string = frameId ?? Bun.randomUUIDv7();
    await this.history.appendMessage({
      id: toolId,
      sessionId: binding.localSessionId,
      userId,
      role: 'tool',
      agentId,
      text: detail,
      createdAt: new Date().toISOString(),
      parentId,
      kind: 'tool',
      name,
      status,
      ...(detail !== null ? { detail } : {}),
    });
    if (frameId !== undefined) this.persistedToolFrameIds.add(frameId);
    this.chainTips.set(binding.localSessionId, toolId);
  }

  /**
   * Stable envelope id of one host broadcast (idempotency key): the
   * top-level frame `id` when the host supplies one, else the payload
   * call identity (`id`/`callId`/`toolCallId`). Undefined when the frame
   * carries no stable identity (live-only markers) — the caller then falls
   * back to a fresh uuid and never dedupes.
   */
  private frameIdOf(
    frame: { id?: unknown } | null,
    data: Record<string, unknown>,
  ): string | undefined {
    if (frame !== null && typeof frame.id === 'string' && frame.id.length > 0) return frame.id;
    const candidates: Array<unknown> = [data.id, data.callId, data.toolCallId];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return undefined;
  }

  /**
   * Single-line 500-char detail snippet without secrets: objects stringify
   * first, whitespace collapses, secret key=value pairs redact. Non-string
   * scalars and empty values write no detail (null).
   */
  private toSafeDetail(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    const text: string =
      typeof raw === 'string' ? raw : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (text.length === 0) return null;
    const single: string = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (single.length === 0) return null;
    return this.redactSecrets(single);
  }

  /**
   * Secret redaction for detail snippets (best-effort, no throw): key=value
   * pairs and JSON secret keys collapse to `[redacted]`, well-known token
   * prefixes (`sk-`, `xox…`, `ghp_…`) collapse too. Never logs, never throws.
   */
  private redactSecrets(text: string): string {
    return text
      .replace(
        /(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer|cookie|session[_-]?id)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
        '$1=[redacted]',
      )
      .replace(
        /("(?:[^"]*(?:token|secret|password|api[_-]?key|authorization)[^"]*)"\s*:\s*")[^"]*(")/gi,
        '$1[redacted]$2',
      )
      .replace(/\bsk-[A-Za-z0-9-_]{10,}\b/g, '[redacted]')
      .replace(/\bxox[bap]-[A-Za-z0-9-]{10,}\b/g, '[redacted]')
      .replace(/\bghp_[A-Za-z0-9]{10,}\b/g, '[redacted]');
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
    // The answer closes the turn chain on the last tool/reasoning link
    // (file-command/in-process shape: receipt → tool → assistant). Only when
    // the turn wrote no links yet (or the turn meta is gone — restart, old
    // test harness) fall back to the linear clock tail — never invent one.
    const receiptParent: string | null | undefined = turn?.receiptId;
    const receiptId: string | undefined =
      receiptParent !== undefined && receiptParent !== null && receiptParent.length > 0
        ? receiptParent
        : undefined;
    const parentId: string | null = await this.resolveChainParent(
      binding.localSessionId,
      receiptId,
    );
    await this.history.appendMessage({
      id: buffer.assistantMessageID,
      sessionId: binding.localSessionId,
      userId,
      role: 'assistant',
      agentId,
      text: buffer.text,
      createdAt: new Date(buffer.createdAt).toISOString(),
      parentId,
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
