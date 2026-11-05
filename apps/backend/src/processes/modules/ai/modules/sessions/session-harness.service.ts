import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { ProjectAccessService } from '../../../../../organizations/modules/projects/modules/project-access/project-access.service';
import { SessionRunnerService } from '../../../../../common/zen/session-runner.service';
import {
  OpencodeHostService,
  type HostProviderList,
  type HostSessionInfo,
} from '../opencode/opencode-host.service';
import { ServeAuthService } from '../opencode/modules/auth/serve-auth.service';
import { AppLogger } from '../../../../../common/logger';
import { relaySse } from '../../../../../common/sse/sse-relay';
import {
  ExternalServiceError,
  fromUnknown,
} from '../../../../../common/external/external-error';
import { AgentsService } from '../agents/agents.service';
import { SessionHistoryRepository } from './session-history.repository';
import type {
  CreateSessionInput,
  InterruptSessionInput,
  SendMessageInput,
  SessionInfo,
  SessionInterruptResult,
  SessionMessage,
  SessionRunStatusMap,
  SessionRunnerProvider,
} from './sessions.dto';
import type { SessionHarness } from './session-harness.types';

/**
 * Provider row — artifact Provider.Info. Only the fields the domain
 * projection reads are typed; settings/headers/body stay unread (headers
 * may carry auth material — never projected outward).
 */
type UpstreamProviderInfo = {
  id?: unknown;
  name?: unknown;
  activation?: unknown;
  package?: unknown;
};

/** Activation gate as a real type predicate (plain boolean variables do
 * not narrow union members under strictNullChecks). */
function isProviderActivation(v: unknown): v is 'auto' | 'enabled' | 'disabled' {
  return v === 'auto' || v === 'enabled' || v === 'disabled';
}

/** True when the throw is the direct runner's honest missing-key signal. */
function isMissingKey(err: unknown): boolean {
  if (!(err instanceof NotFoundException)) return false;
  const res = err.getResponse() as unknown;
  return (
    typeof res === 'object' &&
    res !== null &&
    (res as { code?: unknown }).code === 'opencode_key_missing'
  );
}

/**
 * SessionHarnessService — default SessionHarness behind /api/v1/sessions*.
 *
 * Transport is the embedded OpenCode V2 host (OpencodeHostService, in-process,
 * no external runner URL / no Basic auth). Postgres (SessionHistoryRepository) stays
 * the source of truth for the domain list/thread:
 * - list/listMessages/status read ONLY the durable store — an empty project
 *   is an honest empty answer, never an upstream 503;
 * - create writes our `project_sessions` row first (id = our uuid) and then
 *   binds the host session id into `metadata.opencodeSessionId`; a host that
 *   cannot start rolls the row back and answers an honest 503
 *   EXTERNAL_UNAVAILABLE;
 * - sendMessage keeps the direct per-user Zen runner when a key exists and
 *   otherwise prompts the bound host session; the user receipt is always
 *   written to the durable thread;
 * - interrupt/providers/models/events ride the host helpers and keep the
 *   frozen domain shapes.
 *
 * Domain translation (toSessionInfo-shaped rows, message rows, SSE frames)
 * and the SSE contract stay unchanged. Logs ride AppLogger one-liners without
 * URLs/secrets/stacks.
 */
/** Host session id → durable domain binding (NEVER trusted across projects). */
type HostBinding = { projectId: string; localSessionId: string; userId?: string };

/** In-flight assistant text per host assistant message (recorder). */
type AssistantBuffer = {
  sessionID: string;
  assistantMessageID: string;
  text: string;
  createdAt: number;
};

/** Owner/agent context of the last prompt, used for durable assistant rows. */
type TurnMeta = { userId: string; projectId: string; agentId: string };

@Injectable()
export class SessionHarnessService implements SessionHarness, OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly host: OpencodeHostService,
    private readonly access: ProjectAccessService,
    private readonly auth: ServeAuthService,
    private readonly history: SessionHistoryRepository,
    @Optional() private readonly runner?: SessionRunnerService,
    private readonly logger: AppLogger = new AppLogger(SessionHarnessService.name),
    // Registry of AI agents (sessions→agents DI edge via AgentsModule; the
    // Ask agent answers through the harness-owned runner). Optional only so
    // unit specs wiring the harness by hand keep compiling — in the app the
    // module always provides it, and agent paths fail loud without it.
    @Optional() private readonly agents?: AgentsService,
  ) {}

  /**
   * Buffered direct-runner SSE frames (message-part deltas + snapshot).
   * Live transport only — durable history lives in SessionHistoryRepository.
   */
  private readonly localFrames: Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
  }> = [];

  /** Sessions with an in-flight direct turn (status override until the answer lands). */
  private readonly busyDirect = new Set<string>();

  /**
   * In-process host-id → durable binding written by create(), so SSE
   * subscribers already connected see `session.created`/early frames before
   * the Postgres metadata write lands. Every entry carries its projectId —
   * the map is process-wide but reads are always project-scoped.
   */
  private readonly hostBindings = new Map<string, HostBinding>();

  /** True when the single process-level assistant recorder is subscribed. */
  private recorderStarted = false;
  /** Single-flight guard for the recorder subscription. */
  private recorderStarting: Promise<void> | null = null;
  /** Cancels the recorder on module destroy. */
  private readonly recorderAbort = new AbortController();
  /** Assistant text buffers keyed by `${hostSessionID}\u0000${assistantMessageID}`. */
  private readonly assistantBuffers = new Map<string, AssistantBuffer>();
  /** Owner/agent of the in-flight turn keyed by OUR session uuid. */
  private readonly turnMeta = new Map<string, TurnMeta>();

  onModuleInit(): void {
    // Best-effort: the host may still be booting; ensureAssistantRecorder()
    // is retried from sendMessage/streamEvents.
    void this.ensureAssistantRecorder();
  }

  onModuleDestroy(): void {
    this.recorderAbort.abort();
    this.recorderStarted = false;
    this.assistantBuffers.clear();
    this.turnMeta.clear();
  }

  /** Same non-negative-integer query guard the mirror uses for ?limit. */
  private parseLimit(limitRaw?: string): number | undefined {
    if (limitRaw === undefined) return undefined;
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new BadRequestException('Query "limit" must be a non-negative integer');
    }
    return limit;
  }

  private badShape(operation: string): ExternalServiceError {
    return new ExternalServiceError({
      code: 'EXTERNAL_UNAVAILABLE',
      service: 'opencode',
      operation,
      message: 'сервис временно недоступен, повторите позже',
      isRetryable: false,
      cause: new Error('bad_shape'),
    });
  }

  /** Validate a client-supplied agentId against the registry (honest 404). */
  private resolveAgentId(agentId: string | undefined, cid: string): string | undefined {
    if (agentId === undefined) return undefined;
    const known = this.agents?.list().some((a) => a.id === agentId) ?? false;
    if (!known) {
      this.logger.warn(`[sessions] unknown agent agentId=${agentId}`, cid);
      throw new NotFoundException(`Agent '${agentId}' not found`);
    }
    return agentId;
  }

  /** Drop a staged row without masking the original failure (best effort). */
  private async discardQuietly(sessionId: string, cid: string): Promise<void> {
    try {
      await this.history.discardSession(sessionId);
    } catch (err) {
      this.logger.warn('[sessions] rollback failed', cid);
      this.logger.debug((err as Error).message, cid);
    }
  }

  /** GET /api/v1/sessions?projectId — durable list scoped to the gated jail. */
  async list(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<Array<SessionInfo>> {
    this.auth.assertServeUser(userId, cid);
    const project = await this.access.resolveProjectDirectory(projectId, userId, cid);
    return this.history.listLocalSessions(project.projectId);
  }

  /** GET /api/v1/sessions/status?projectId — sessionId → runtime status. */
  async statusMap(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<SessionRunStatusMap> {
    const rows = await this.list(userId, projectId, cid);
    const map: SessionRunStatusMap = {};
    for (const row of rows) {
      map[row.id] = this.busyDirect.has(row.id) ? { type: 'busy' } : { type: 'idle' };
    }
    return map;
  }

  /**
   * POST /api/v1/sessions — durable row first (our uuid), then the embedded
   * host session; the host id is stored in `metadata.opencodeSessionId`.
   * A host failure soft-deletes the staged row and answers the typed 503.
   */
  async create(userId: string, body: CreateSessionInput, cid: string): Promise<SessionInfo> {
    this.auth.assertServeUser(userId, cid);
    const project = await this.access.resolveProjectDirectory(body.projectId, userId, cid);
    // Fail fast on an unknown agent (honest 404, no side effects) before any
    // durable/host work; undefined keeps the pre-agent behavior (agentId null).
    const agentId = this.resolveAgentId(body.agentId, cid);
    const id = Bun.randomUUIDv7();
    const info: SessionInfo = {
      id,
      title: body.title ?? null,
      createdAt: new Date().toISOString(),
      directory: project.directory,
      projectId: project.projectId,
      model: body.model ?? null,
      agentId: agentId ?? null,
      status: { type: 'idle' },
    };
    // Row first: the domain id exists before the host does, and list/status
    // never need an upstream round-trip.
    await this.history.saveLocalSession(info, userId);

    let created: HostSessionInfo;
    try {
      created = await this.host.sessionCreate({
        directory: project.directory,
        title: body.title,
        parentID: body.parentID,
        model: body.model,
        agent: agentId,
      });
    } catch (err) {
      // No half state: the row never becomes a visible session without a host
      // binding. The error keeps its honest mapping (4xx stays 4xx, outage 503).
      await this.discardQuietly(id, cid);
      if (err instanceof ExternalServiceError || err instanceof HttpException) throw err;
      throw fromUnknown('opencode', 'sessionsCreate', err);
    }

    // Bind before persisting so live SSE subscribers can resolve the host id.
    this.hostBindings.set(created.id, {
      projectId: project.projectId,
      localSessionId: id,
      userId,
    });
    try {
      await this.history.setHostSessionId(id, created.id);
      if (agentId !== undefined) {
        await this.history.setAgent(id, project.projectId, agentId);
      }
    } catch (err) {
      // Postgres outage after the host session exists: drop both sides so a
      // retry does not leave an orphan host session or a phantom row.
      this.hostBindings.delete(created.id);
      await this.host.sessionRemove(created.id).catch(() => undefined);
      await this.discardQuietly(id, cid);
      throw err;
    }

    this.logger.info('[sessions] created', cid);
    return {
      ...info,
      title:
        typeof created.title === 'string' && created.title.length > 0
          ? created.title
          : info.title,
    };
  }

  /**
   * GET /api/v1/sessions/{id}/messages — durable Postgres thread only.
   * `limit` keeps its validation contract (400 on garbage) but the durable
   * read has no cursor semantics; an unknown session is an honest empty array.
   */
  async listMessages(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    limitRaw: string | undefined,
    _cursor: string | undefined,
    cid: string,
  ): Promise<Array<SessionMessage>> {
    this.auth.assertServeUser(userId, cid);
    await this.access.resolveProjectDirectory(projectId, userId, cid);
    this.parseLimit(limitRaw);
    return this.history.listMessages(sessionId);
  }

  /**
   * POST /api/v1/sessions/{id}/messages — direct agent turn when a per-user
   * key exists, otherwise the bound embedded host session. The user receipt
   * is persisted in the durable thread on both paths.
   */
  async sendMessage(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage> {
    await this.access.resolveProjectDirectory(body.projectId, userId, cid);
    this.auth.assertServeUser(userId, cid);
    // Fail fast on an unknown agent (honest 404, no side effects) before any
    // transport work — both paths share this gate.
    this.resolveAgentId(body.agentId, cid);
    // Transport selection (explicit, user-sanctioned): a stored per-user Zen
    // key answers through the direct runner (no host prompt needed); without
    // a key (404 opencode_key_missing) the bound host session owns the turn.
    if (this.runner) {
      try {
        return await this.sendMessageDirect(userId, sessionId, body, cid);
      } catch (err) {
        if (!isMissingKey(err)) throw err;
        this.logger.warn('[sessions] direct runner skipped code=opencode_key_missing', cid);
      }
    }
    return this.sendMessageViaHost(userId, sessionId, body, cid);
  }

  /**
   * Direct turn: the answer comes from the session's agent (AgentsService —
   * sessions→agents DI edge; the Ask agent answers through the harness-owned
   * runner behind the caller's key). Both turns land in the durable Postgres
   * history and the token frames stay in the live SSE buffer. A late answer
   * after interrupt() is dropped (the partial commit already belongs to stop()).
   */
  private async sendMessageDirect(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage> {
    const runner = this.runner;
    if (!runner) {
      throw new NotFoundException({
        code: 'opencode_key_missing',
        message: 'No OpenCode API key configured for this user',
      });
    }
    if (!this.agents) throw new Error('AgentsService is not wired');
    const agentId =
      this.resolveAgentId(body.agentId, cid) ??
      (await this.history.getAgent(sessionId)) ??
      'ask';
    await this.history.setAgent(sessionId, body.projectId, agentId);
    void body.model;
    const receipt: SessionMessage = {
      id: Bun.randomUUIDv7(),
      type: 'user',
      createdAt: new Date().toISOString(),
      text: body.text,
    };
    // Persist the user turn BEFORE the agent runs: an interrupt drops the
    // answer but the question already belongs to the durable thread.
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
    this.busyDirect.add(sessionId);
    const assistantId = Bun.randomUUIDv7();
    try {
      const answer = await this.agents.askQuestion(agentId, body.text, userId, cid);
      if (!this.busyDirect.has(sessionId)) {
        this.logger.info('[sessions] direct answer dropped after interrupt', cid);
        return receipt;
      }
      const assistant: SessionMessage = {
        id: assistantId,
        type: 'assistant',
        createdAt: new Date().toISOString(),
        text: answer,
      };
      await this.history.appendMessage({
        id: assistant.id,
        sessionId,
        projectId: body.projectId,
        userId,
        role: 'assistant',
        agentId,
        text: answer,
        createdAt: assistant.createdAt,
      });
      this.bufferDirectFrames(sessionId, assistant);
      this.bufferDirectIdle(sessionId);
      this.logger.info('[sessions] prompt answered directly', cid);
      return receipt;
    } catch (err) {
      // Missing per-user key: the direct transport never started, so the
      // staged receipt is discarded — the host fallback owns the durable row.
      if (isMissingKey(err)) {
        await this.history.discardMessage(receipt.id);
        throw err;
      }
      if (err instanceof ExternalServiceError && err.service === 'db') throw err;
      this.logger.warn('[sessions] direct prompt failed', cid);
      this.logger.debug((err as Error).message, cid);
      if (err instanceof HttpException) throw err;
      throw fromUnknown('zen', 'sessionPromptDirect', err);
    } finally {
      this.busyDirect.delete(sessionId);
    }
  }

  /**
   * Terminal frame for a completed direct turn: the frontend useChat send()
   * finalizes (clears sending) only on session.idle.
   */
  private bufferDirectIdle(sessionId: string): void {
    this.localFrames.push({
      id: Bun.randomUUIDv7(),
      type: 'session.idle',
      data: { sessionID: sessionId },
    });
    while (this.localFrames.length > 500) this.localFrames.shift();
  }

  /**
   * Chunk a direct answer into contract-narrowed token frames (delta slices +
   * the absolute snapshot) for the harness SSE buffer. The frontend already
   * parses exactly these two variants (useChat frameText) — no client change.
   */
  private bufferDirectFrames(sessionId: string, assistant: SessionMessage): void {
    const text = assistant.text ?? '';
    if (!text) return;
    const partID = `prt_${assistant.id}`;
    const CHUNK = 200;
    for (let i = 0; i < text.length; i += CHUNK) {
      this.localFrames.push({
        id: Bun.randomUUIDv7(),
        type: 'message.part.delta',
        data: {
          sessionID: sessionId,
          messageID: assistant.id,
          partID,
          field: 'text',
          delta: text.slice(i, i + CHUNK),
        },
      });
    }
    this.localFrames.push({
      id: Bun.randomUUIDv7(),
      type: 'message.part.updated',
      data: { sessionID: sessionId, part: { id: partID, type: 'text', text } },
    });
    while (this.localFrames.length > 500) this.localFrames.shift();
  }

  /**
   * Host-backed turn: resolve the bound host session id from
   * `metadata.opencodeSessionId`, prompt it, and persist the returned user
   * receipt in the durable thread (so a reload keeps the question even though
   * the answer streams over events).
   */
  private async sendMessageViaHost(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage> {
    const agentId =
      this.resolveAgentId(body.agentId, cid) ??
      (await this.history.getAgent(sessionId)) ??
      'ask';
    if (body.agentId !== undefined) {
      await this.history.setAgent(sessionId, body.projectId, agentId);
    }
    const hostSessionId = await this.history.getHostSessionId(sessionId, body.projectId);
    if (!hostSessionId) {
      throw new NotFoundException({
        code: 'opencode_session_unbound',
        message: 'Session is not bound to the embedded OpenCode host',
      });
    }
    // The assistant recorder must be subscribed BEFORE the prompt so no early
    // delta is lost; a failure there is logged but never blocks the prompt.
    this.hostBindings.set(hostSessionId, {
      projectId: body.projectId,
      localSessionId: sessionId,
      userId,
    });
    this.turnMeta.set(sessionId, {
      userId,
      projectId: body.projectId,
      agentId,
    });
    await this.ensureAssistantRecorder();
    void body.model; // model is pinned at create; prompt has no model field
    const receipt = await this.host.sessionPrompt(hostSessionId, body.text);
    const mapped: SessionMessage = {
      id: receipt.id,
      type: receipt.type,
      createdAt: new Date(receipt.time.created).toISOString(),
      text:
        typeof receipt.payload.text === 'string' && receipt.payload.text.length > 0
          ? receipt.payload.text
          : null,
    };
    await this.history.appendMessage({
      id: mapped.id,
      sessionId,
      projectId: body.projectId,
      userId,
      role: 'user',
      agentId,
      text: body.text,
      createdAt: mapped.createdAt,
    });
    this.logger.info('[sessions] prompt accepted', cid);
    return mapped;
  }

  /**
   * Starts the single process-level host-event recorder (once). It persists
   * assistant text into `session_messages` so a reload keeps the answer even
   * though the inbound endpoint only answers the queued user receipt.
   */
  private async ensureAssistantRecorder(): Promise<void> {
    if (this.recorderStarted) return;
    this.recorderStarting ??= this.startAssistantRecorder();
    await this.recorderStarting;
  }

  private async startAssistantRecorder(): Promise<void> {
    try {
      const stream = await this.host.subscribeEvents(this.recorderAbort.signal);
      if (this.recorderAbort.signal.aborted) return;
      this.recorderStarted = true;
      void this.consumeHostEvents(stream);
    } catch (err) {
      if (!this.recorderAbort.signal.aborted) {
        this.logger.warn('[sessions] assistant recorder unavailable', '');
        this.logger.debug((err as Error).message, '');
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
        } catch (err) {
          // One bad frame/DB write never kills the process-level recorder.
          this.logger.warn('[sessions] assistant persist failed', '');
          this.logger.debug((err as Error).message, '');
        }
      }
    } catch (err) {
      if (!this.recorderAbort.signal.aborted) {
        this.logger.warn('[sessions] assistant recorder stopped', '');
        this.logger.debug((err as Error).message, '');
      }
    } finally {
      this.recorderStarted = false;
    }
  }

  /** Accumulate assistant text and persist it idempotently on turn end. */
  private async recordHostEvent(event: unknown): Promise<void> {
    const frame = event as { type?: unknown; created?: unknown; data?: unknown } | null;
    const type = typeof frame?.type === 'string' ? frame.type : '';
    const data =
      frame && typeof frame.data === 'object' && frame.data !== null
        ? (frame.data as Record<string, unknown>)
        : {};
    const sessionID = typeof data.sessionID === 'string' ? data.sessionID : undefined;
    if (!sessionID) return;
    const assistantMessageID =
      typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined;
    const createdRaw = frame?.created;
    const createdAt =
      typeof createdRaw === 'number' && Number.isFinite(createdRaw) ? createdRaw : Date.now();

    if (type === 'session.text.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : '';
      if (!assistantMessageID || delta.length === 0) return;
      const key = `${sessionID}\u0000${assistantMessageID}`;
      const buffer = this.assistantBuffers.get(key) ?? {
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
      const key = `${sessionID}\u0000${assistantMessageID}`;
      const full = typeof data.text === 'string' ? data.text : '';
      const buffer = this.assistantBuffers.get(key) ?? {
        sessionID,
        assistantMessageID,
        text: '',
        createdAt,
      };
      if (full.length > 0) buffer.text = full;
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
      const prefix = `${sessionID}\u0000`;
      for (const key of [...this.assistantBuffers.keys()]) {
        if (key.startsWith(prefix)) await this.flushAssistant(key);
      }
      const binding = await this.resolveHostBinding(sessionID);
      if (binding) this.turnMeta.delete(binding.localSessionId);
    }
  }

  /** Idempotent: message id = host assistantMessageID (PK conflict = no-op). */
  private async flushAssistant(key: string): Promise<void> {
    const buffer = this.assistantBuffers.get(key);
    if (!buffer) return;
    if (buffer.text.length === 0) {
      this.assistantBuffers.delete(key);
      return;
    }
    const binding = await this.resolveHostBinding(buffer.sessionID);
    if (!binding) {
      this.assistantBuffers.delete(key);
      return;
    }
    const turn = this.turnMeta.get(binding.localSessionId);
    const userId = binding.userId ?? turn?.userId;
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
    const cached = this.hostBindings.get(hostSessionId);
    if (cached) return cached;
    const found = await this.history.findSessionByHostSessionId(hostSessionId);
    if (!found) return undefined;
    const binding: HostBinding = {
      projectId: found.projectId,
      localSessionId: found.id,
      ...(found.userId !== undefined ? { userId: found.userId } : {}),
    };
    this.hostBindings.set(hostSessionId, binding);
    return binding;
  }

  /**
   * Translate one host/domain event into our SSE frame:
   * {id, type, data} passthrough with the host session id re-keyed to OUR
   * session uuid via `resolve`; `session` is hoisted from data.sessionID.
   * Upstream top-level extras are dropped; data stays variant-owned.
   */
  private toStreamFrame(
    value: unknown,
    resolve: (sessionId: string) => string | undefined,
  ): Record<string, unknown> {
    const frame = value as { id?: unknown; type?: unknown; data?: unknown } | null;
    const data: Record<string, unknown> =
      frame && typeof frame.data === 'object' && frame.data !== null
        ? { ...(frame.data as Record<string, unknown>) }
        : {};
    const rawSession =
      typeof data.sessionID === 'string' ? (data.sessionID as string) : undefined;
    const localSession = rawSession ? resolve(rawSession) : undefined;
    if (localSession) data.sessionID = localSession;
    const out: Record<string, unknown> = { id: frame?.id, type: frame?.type, data };
    if (localSession) out.session = localSession;
    return out;
  }

  /**
   * GET /api/v1/sessions/events — SSE re-stream of the embedded host event
   * bus, MERGED with the harness-owned direct-runner buffer. The C4 gate
   * decides WHO may stream; the bus is process-global, so frames are filtered
   * to sessions of the gated project (our uuids).
   *
   * The stream ends on downstream close (relaySse aborts the signal), on the
   * idle timeout (no busy direct turn AND no new local/host frame), or on
   * the overall STREAM_CAP_MS. Full content remains available via history.
   */
  async streamEvents(
    userId: string,
    projectId: string | undefined,
    cid: string,
    req: ExpressRequest,
    res: ExpressResponse,
  ): Promise<void> {
    this.auth.assertServeUser(userId, cid);
    const project = await this.access.resolveProjectDirectory(projectId, userId, cid);
    const localSessionIds = new Set<string>();
    for (const s of await this.history.listLocalSessions(project.projectId)) {
      localSessionIds.add(s.id);
    }
    for (const sid of await this.history.listSessionIdsWithMessages(project.projectId)) {
      localSessionIds.add(sid);
    }
    const persisted = await this.history.listHostBindings(project.projectId);
    // Project-scoped resolver: the process-wide hostBindings map carries the
    // owner projectId, so a session of project B can never be re-keyed and
    // admitted into project A's stream.
    const resolve = (sessionId: string): string | undefined => {
      const memory = this.hostBindings.get(sessionId);
      const fromMemory =
        memory !== undefined && memory.projectId === project.projectId
          ? memory.localSessionId
          : undefined;
      const fromDb = persisted.get(sessionId);
      const direct = localSessionIds.has(sessionId) ? sessionId : undefined;
      const local = fromMemory ?? fromDb ?? direct;
      // A session created while this stream is open becomes visible through
      // the in-process binding before the DB metadata write is reloaded.
      if (local !== undefined) localSessionIds.add(local);
      return local;
    };
    // Keep the durable assistant recorder running even if boot raced the host.
    await this.ensureAssistantRecorder();

    // Live refs for the merge closure (same array/set identity — appends and
    // the busyDirect override stay visible to the running generator).
    const frames = this.localFrames;
    const busy = this.busyDirect;
    await relaySse({
      operation: 'GET /api/v1/sessions/events',
      cid,
      req,
      res,
      logger: this.logger,
      prefix: '[sessions]',
      probe: async () => {
        try {
          await this.host.getHost();
          return 'up' as const;
        } catch {
          return 'down' as const;
        }
      },
      unreachableError: () =>
        new ExternalServiceError({
          code: 'EXTERNAL_UNAVAILABLE',
          service: 'opencode',
          operation: 'sessionEvents',
          message: 'сервис временно недоступен, повторите позже',
          isRetryable: true,
          cause: new Error('unreachable'),
        }),
      subscribeFailedError: (err) => fromUnknown('opencode', 'sessionEvents', err),
      subscribe: async (signal) => {
        const replay = frames.filter((f) => {
          const sid = typeof f.data.sessionID === 'string' ? f.data.sessionID : undefined;
          return sid !== undefined && localSessionIds.has(sid);
        });
        let cursor = frames.length;
        const live = await this.host.subscribeEvents(signal);
        let liveIt: AsyncIterator<unknown> | null = live[Symbol.asyncIterator]();
        const startedAt = Date.now();
        let lastActivityAt = Date.now();
        const LOCAL_IDLE_MS = 30_000;
        const STREAM_CAP_MS = 300_000;
        const POLL_MS = 250;
        const stream = (async function* (): AsyncGenerator<unknown> {
          try {
            for (const frame of replay) {
              if (signal.aborted) return;
              yield frame;
            }
            while (!signal.aborted) {
            while (cursor < frames.length) {
              const f = frames[cursor];
              cursor += 1;
              const sid = typeof f.data.sessionID === 'string' ? f.data.sessionID : undefined;
              if (sid !== undefined && localSessionIds.has(sid)) {
                lastActivityAt = Date.now();
                yield f;
              }
            }
            const next =
              liveIt === null
                ? null
                : await Promise.race([
                    liveIt.next(),
                    new Promise<null>((resolveIdle) => {
                      setTimeout(() => resolveIdle(null), POLL_MS);
                    }),
                  ]);
            if (signal.aborted) return;
            if (next !== null && next.done) {
              liveIt = null;
            } else if (next !== null) {
              lastActivityAt = Date.now();
              yield next.value;
            }
            if (Date.now() - startedAt > STREAM_CAP_MS) return;
            let busyLocal = false;
            for (const sid of localSessionIds) {
              if (busy.has(sid)) {
                busyLocal = true;
                break;
              }
            }
            if (liveIt === null && !busyLocal && cursor >= frames.length) return;
            if (liveIt === null) {
              await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
              if (signal.aborted) return;
            }
            if (!busyLocal && Date.now() - lastActivityAt > LOCAL_IDLE_MS) return;
            }
          } finally {
            // Downstream close / normal end / error: never leave the host bus
            // iterator (and its reader) attached to this client forever.
            const iterator = liveIt;
            liveIt = null;
            try {
              await iterator?.return?.(undefined);
            } catch {
              /* abort during teardown is expected */
            }
          }
        })();
        return { stream };
      },
      filterFrame: (frame) => {
        const f = frame as { data?: unknown; session?: unknown } | null;
        const data =
          f && typeof f.data === 'object' && f.data !== null
            ? (f.data as Record<string, unknown>)
            : {};
        const session =
          typeof f?.session === 'string'
            ? f.session
            : typeof data.sessionID === 'string'
              ? data.sessionID
              : undefined;
        return typeof session === 'string' && localSessionIds.has(session);
      },
      mapFrame: (value) => this.toStreamFrame(value, resolve),
    });
  }

  /**
   * POST /api/v1/sessions/{id}/interrupt — interrupt the bound host session.
   * A local direct turn is marked interrupted here (its late answer is
   * dropped); an idle direct session keeps the honest no-op answer.
   */
  async interrupt(
    userId: string,
    sessionId: string,
    body: InterruptSessionInput,
    cid: string,
  ): Promise<SessionInterruptResult> {
    this.auth.assertServeUser(userId, cid);
    await this.access.resolveProjectDirectory(body.projectId, userId, cid);
    const localInterrupted = this.busyDirect.delete(sessionId);
    // Guarantee the hanging client sending flag clears even if the terminal
    // session.idle was lost.
    if (localInterrupted) this.bufferDirectIdle(sessionId);
    const hostSessionId = await this.history.getHostSessionId(sessionId, body.projectId);
    if (!hostSessionId) {
      if (localInterrupted) return { interrupted: true };
      throw new NotFoundException({
        code: 'opencode_session_unbound',
        message: 'Session is not bound to the embedded OpenCode host',
      });
    }
    try {
      const answer = await this.host.sessionInterrupt(hostSessionId);
      this.logger.info('[sessions] interrupted', cid);
      return { interrupted: answer.interrupted || localInterrupted };
    } catch (err) {
      this.logger.warn('[sessions] interrupt failed', cid);
      this.logger.debug((err as Error).message, cid);
      const mapped =
        err instanceof ExternalServiceError
          ? err
          : fromUnknown('opencode', 'sessionInterrupt', err);
      // Host does not know the session but we did interrupt a direct turn.
      if (localInterrupted && mapped.code === 'EXTERNAL_NOT_FOUND') {
        this.logger.info('[sessions] interrupted locally', cid);
        return { interrupted: true };
      }
      throw mapped;
    }
  }

  /**
   * GET /api/v1/sessions/providers — the project's host provider inventory.
   * The domain row is the REQUIRED artifact subset
   * (Provider.Info: id/name/activation/package); settings/headers/body are
   * never projected. A row violating the required set fails loud.
   */
  async providers(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<Array<SessionRunnerProvider>> {
    this.auth.assertServeUser(userId, cid);
    const project = await this.access.resolveProjectDirectory(projectId, userId, cid);
    let env: HostProviderList;
    try {
      env = await this.host.providerList(project.directory);
    } catch (err) {
      this.logger.warn('[sessions] providers list failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw err;
    }
    const rows = (env as { data?: unknown }).data;
    if (!Array.isArray(rows)) throw this.badShape('sessionProviders');
    return (rows as unknown as Array<UpstreamProviderInfo>).map((p) => {
      if (
        typeof p.id !== 'string' ||
        p.id.length === 0 ||
        typeof p.name !== 'string' ||
        typeof p.package !== 'string' ||
        !isProviderActivation(p.activation)
      ) {
        throw this.badShape('sessionProviders');
      }
      return { id: p.id, name: p.name, activation: p.activation, package: p.package };
    });
  }

  /**
   * GET /api/v1/sessions/models — host model inventory filtered to the
   * OpenCode Go/Zen family (provider id opencode / opencode-go / opencode-zen).
   */
  async models(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<Array<{ id: string; name: string; providerID: string }>> {
    this.auth.assertServeUser(userId, cid);
    const project = await this.access.resolveProjectDirectory(projectId, userId, cid);
    let env: { data?: unknown };
    try {
      env = await this.host.modelList(project.directory);
    } catch (err) {
      this.logger.warn('[sessions] models list failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw err;
    }
    const rows = env.data;
    if (!Array.isArray(rows)) throw this.badShape('sessionModels');
    const out: Array<{ id: string; name: string; providerID: string }> = [];
    for (const raw of rows as unknown as Array<Record<string, unknown>>) {
      const providerID = typeof raw.providerID === 'string' ? raw.providerID : '';
      if (!['opencode', 'opencode-go', 'opencode-zen'].includes(providerID)) continue;
      const modelID =
        typeof raw.modelID === 'string'
          ? raw.modelID
          : typeof raw.id === 'string'
            ? raw.id
            : '';
      const name = typeof raw.name === 'string' ? raw.name : modelID;
      if (!modelID) throw this.badShape('sessionModels');
      out.push({ id: modelID, name, providerID });
    }
    this.logger.info('[sessions] models listed', cid);
    return out;
  }
}
