import { BadRequestException, HttpException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { ProjectAccessService } from '../../../../../organizations/modules/projects/modules/project-access/project-access.service';
import { SessionRunnerService } from '../../../../../common/zen/session-runner.service';
import { OpencodeSdkClient } from '../opencode/opencode-sdk-client';
import { OpencodeService } from '../opencode/opencode.service';
import {
  ServeAuthService,
  serveBasicAuthHeader,
} from '../opencode/modules/auth/serve-auth.service';
import { AppLogger } from '../../../../../common/logger';
import { relaySse } from '../../../../../common/sse/sse-relay';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from '../../../../../common/external/external-error';
import { AgentsService } from '../agents/agents.service';
import { SessionHistoryRepository } from './session-history.repository';
import type {
  CreateSessionInput,
  InterruptSessionInput,
  SendMessageInput,
  SessionInfo,
  SessionInfoModel,
  SessionInterruptResult,
  SessionMessage,
  SessionRunStatus,
  SessionRunStatusMap,
  SessionRunnerProvider,
} from './sessions.dto';
import type { SessionHarness } from './session-harness.types';

/**
 * Upstream session row as the live 2.2.0 stand answers it.
 * Provenance: contracts/opencode-stand-2.2.0.json Session.Info (required
 * id, projectID, cost, tokens, time, location; title optional). The sdk's
 * declared response type is narrowed here to the fields the translation
 * actually reads.
 */
type UpstreamSession = {
  id: string;
  projectID: string;
  title?: string;
  time: { created: number; updated: number };
  location: { directory: string };
  model?: { id?: string; providerID?: string; variant?: string };
};

/** Envelope the v2 list/create endpoints answer ({data} unwrapped). */
type UpstreamEnvelope<T> = { data?: T };

/**
 * Upstream message row — a variant of the `Session.Message.Info` union
 * (provenance: artifact Session.Message.*). Only the fields the projection
 * reads are typed; `content` carries the assistant's text parts.
 */
type UpstreamMessage = {
  id: string;
  type: string;
  time: { created: number };
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
};

/** v2 prompt receipt (`Session.Inbox.User`) — the queued user payload. */
type UpstreamInboxUser = {
  id: string;
  type: string;
  time: { created: number };
  payload?: { text?: string };
};

/**
 * Upstream provider row — artifact Provider.Info. Only the fields the
 * domain projection reads are typed; settings/headers/body stay unread
 * (headers may carry auth material — never projected outward).
 */
type UpstreamProviderInfo = {
  id?: unknown;
  name?: unknown;
  activation?: unknown;
  package?: unknown;
};

/** v2 provider answer envelope (artifact GET /api/provider). */
type UpstreamProviderEnvelope = { data?: unknown; location?: unknown };

/** Activation gate as a real type predicate — plain boolean variables do
 * not narrow union members under strictNullChecks. Provenance: artifact
 * Provider.Info.activation enum. */
function isProviderActivation(v: unknown): v is 'auto' | 'enabled' | 'disabled' {
  return v === 'auto' || v === 'enabled' || v === 'disabled';
}

/** True when the throw is the runner's honest missing-key signal (transport selection). */
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
 * Card 1 (harness-core): the orchestrator interface is domain-only
 * (SessionInfo / SessionMessage / SessionStreamFrame from
 * @rush-code/contracts); THIS implementation still rides the opencode serve
 * transport (:4096) through the exact building blocks the removed
 * /api/opencode/* mirror used (no behavior change there):
 * - reads (session list, active set, providers, models, interrupt) ride
 *   the v2 sdk surface through OpencodeSdkClient (real-user gate +
 *   ExternalClient retry/timeout);
 * - create + prompt post through OpencodeService.fetchWithRetry directly
 *   with the server Basic header — the pinned sdk 1.18.33 generated create()
 *   sends only id/agent/model/location (title/parentID would be silently
 *   dropped), and the generated prompt() sends a `prompt` key while the live
 *   2.2.0 spec requires `text` with additionalProperties:false (provenance:
 *   contracts/opencode-stand-2.2.0.json). Both stay one transport layer
 *   below the generator; interrupt cleared the same gap earlier by moving
 *   onto `client.v2.session.interrupt` (the runtime parses the live 200
 *   {interrupted} despite the stale 204-void typing);
 * - status is DERIVED from live data (GET /api/session/active — the 2.x
 *   spec's running-drain map): busy while a session has an active drain,
 *   idle otherwise. The legacy GET /session/status the removed mirror
 *   proxied is not served by 2.x (SPA catch-all → 503), so deriving from the active
 *   map is the only REST-reachable source; the transient `retry` state
 *   lives in the event stream, not in snapshots. Interrupt and the model
 *   inventory ride the same sdk client (interrupt posts no body; the model
 *   list is scoped to the gated jail via the v2 location query).
 *
 * Card 2 replaces the transport below this interface with direct provider
 * calls (no new wire shapes); the domain translation here (toSessionInfo /
 * toSessionMessage / toStreamFrame) and the SSE contract stay frozen.
 *
 * Config flows only through OpencodeService/OpencodeConfig (common/env/env.ts
 * strict source — this service reads no env itself); logs ride AppLogger
 * one-liners without secrets (no URLs/headers/bodies); failures map through
 * the shared external-error semantics (external-error fromStatus/fromUnknown):
 * request-level upstream 4xx answer honest 400/404 EXTERNAL_BAD_REQUEST /
 * EXTERNAL_NOT_FOUND (no Retry-After), real outages stay 503
 * EXTERNAL_UNAVAILABLE + Retry-After. No fallbacks: no projectId → 400
 * PROJECT_REQUIRED, no jailed dir → the gate error propagates (never a
 * cwd/default location), no upstream URL defaults.
 *
 * Own runner (cutover from `opencode serve` :4096): model answers ride
 * SessionRunnerService (common/zen — direct per-user Zen calls behind the
 * caller's decrypted key, same rotation as billing). Transport selection is
 * explicit, never silent: a stored key → direct answer (no stand needed);
 * 404 opencode_key_missing → the prompt queues on the serve stand while it
 * lives (legacy path). History/statuses/SSE additionally overlay the durable
 * Postgres history (SessionHistoryRepository) so a dead stand AND a backend
 * restart still serve what the harness itself created (gate-scoped first —
 * strangers never read it). No process-memory fallback remains.
 */
@Injectable()
export class SessionHarnessService implements SessionHarness {
  constructor(
    private readonly sdk: OpencodeSdkClient,
    private readonly opencode: OpencodeService,
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

  /** Legacy runner circuit breaker: set when a list/messages call proves it is down. */
  private runnerDownUntil = 0;

  private markRunnerDown(): void {
    this.runnerDownUntil = Date.now() + 30_000;
  }

  private isRunnerDown(): boolean {
    return Date.now() < this.runnerDownUntil;
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

  private isUpstreamOk<T>(data: T | undefined, error: unknown): data is T {
    return data !== undefined && error === undefined;
  }

  private sdkStatus(result: { response?: { status?: number } }): number | undefined {
    const status = result.response?.status;
    return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
  }

  private upstreamError(operation: string, error: unknown, status?: number): Error {
    if (status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599) {
      return fromStatus('opencode', operation, status, 1, error);
    }
    return fromUnknown('opencode', operation, error ?? new Error('upstream_error'));
  }

  /** Session ids with a live drain on the server (GET /api/session/active). */
  private async activeSessionIds(client: OpencodeClient, cid: string): Promise<Set<string>> {
    const res = await client.v2.session.active();
    if (this.isUpstreamOk(res.data, res.error)) {
      const map =
        (res.data as unknown as UpstreamEnvelope<Record<string, unknown>>).data ?? {};
      return new Set(Object.keys(map));
    }
    throw this.upstreamError('sessionsActive', res.error, this.sdkStatus(res));
  }

  /** Upstream row + our projectId (the gate-bound uuid, NOT the upstream
   * project hash) + stored agent + derived status → domain SessionInfo. */
  private toSessionInfo(
    s: UpstreamSession,
    projectId: string,
    active: Set<string>,
    agentId: string | null = null,
  ): SessionInfo {
    let model: SessionInfoModel | null = null;
    const m = s.model;
    if (m && typeof m.id === 'string' && typeof m.providerID === 'string') {
      model = {
        id: m.id,
        providerID: m.providerID,
        ...(m.variant !== undefined ? { variant: m.variant } : {}),
      };
    }
    const status: SessionRunStatus = active.has(s.id) ? { type: 'busy' } : { type: 'idle' };
    return {
      id: s.id,
      title: typeof s.title === 'string' && s.title.length > 0 ? s.title : null,
      createdAt: new Date(s.time.created).toISOString(),
      directory: s.location.directory,
      projectId,
      model,
      agentId,
      status,
    };
  }

  /**
   * Validate a client-supplied agentId against the registry (AgentsService —
   * sessions→agents DI edge). Unknown ids fail loud as an honest 404 (never
   * a fallback to another agent); undefined passes through (caller applies
   * the session/default resolution). Without the registry wired (hand-rolled
   * unit specs only) any explicit id is unknown — same honest 404.
   */
  private resolveAgentId(agentId: string | undefined, cid: string): string | undefined {
    if (agentId === undefined) return undefined;
    const known = this.agents?.list().some((a) => a.id === agentId) ?? false;
    if (!known) {
      this.logger.warn(`[sessions] unknown agent agentId=${agentId}`, cid);
      throw new NotFoundException(`Agent '${agentId}' not found`);
    }
    return agentId;
  }

  /**
   * List the gated project's sessions on an already-resolved project + client
   * (callers that already hold both must not re-run the C4 gate / re-create
   * the sdk client).
   */
  private async listWithClient(
    client: OpencodeClient,
    project: { projectId: string; directory: string },
    cid: string,
  ): Promise<Array<SessionInfo>> {
    let rows: Array<UpstreamSession>;
    let active: Set<string>;
    try {
      const [res, activeIds] = await Promise.all([
        client.v2.session.list({ directory: project.directory }),
        this.activeSessionIds(client, cid),
      ]);
      if (!this.isUpstreamOk(res.data, res.error)) {
        throw this.upstreamError('sessionsList', res.error, this.sdkStatus(res));
      }
      rows = (res.data as unknown as UpstreamEnvelope<Array<UpstreamSession>>).data ?? [];
      active = activeIds;
    } catch (err) {
      this.logger.warn('[sessions] list failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('sessionsList', err);
    }
    // Stored agent choice is durable (survives restart) — one project-scoped
    // query instead of N lookups; DB errors propagate as 503 outside the
    // upstream mapping above.
    const agents = await this.history.listAgents(project.projectId);
    return rows.map((s) => this.toSessionInfo(s, project.projectId, active, agents.get(s.id) ?? null));
  }

  /** GET /api/v1/sessions?projectId — list scoped to the gated jail. */
  async list(userId: string, projectId: string | undefined, cid: string): Promise<Array<SessionInfo>> {
    const project = await this.access.resolveProjectDirectory(projectId, userId, cid);
    const memory = await this.history.listLocalSessions(project.projectId);
    try {
      const client = await this.sdk.create(userId, cid);
      const rows = await this.listWithClient(client, project, cid);
      const seen = new Set(rows.map((row) => row.id));
      return [...rows, ...memory.filter((s) => !seen.has(s.id))];
    } catch (err) {
      // The runner is legacy; the durable store is the source of truth — an
      // empty list is honest. Serve it (already gate-scoped above) instead of
      // failing whenever the runner is unavailable. Nest HTTP throws (the C4
      // gate 404, the real-user 401) stay honest — they never read the store.
      if (err instanceof HttpException) throw err;
      // Request-level answers (401/404/400) stay honest; only a real runner
      // outage/timeout falls back to the durable store.
      if (
        err instanceof ExternalServiceError &&
        err.code !== 'EXTERNAL_UNAVAILABLE' &&
        err.code !== 'EXTERNAL_TIMEOUT'
      ) {
        throw err;
      }
      this.logger.warn('[sessions] list served from durable store', cid);
      this.logger.debug((err as Error).message, cid);
      this.markRunnerDown();
      return memory;
    }
  }

  /** GET /api/v1/sessions/status?projectId — sessionId → derived runtime status. */
  async statusMap(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<SessionRunStatusMap> {
    const rows = await this.list(userId, projectId, cid);
    const map: SessionRunStatusMap = {};
    for (const row of rows) {
      map[row.id] = this.busyDirect.has(row.id) ? { type: 'busy' } : row.status;
    }
    return map;
  }

  /**
   * POST /api/v1/sessions — create in the gated jail, honestly forwarding
   * title/parentID/model. The body is built non-empty ({location} always present)
   * because the 2.x create endpoint rejects a missing JSON object; it rides
   * fetchWithRetry (not the sdk) because the pinned generated create()
   * silently drops every field except id/agent/model/location.
   */
  async create(userId: string, body: CreateSessionInput, cid: string): Promise<SessionInfo> {
    const project = await this.access.resolveProjectDirectory(body.projectId, userId, cid);
    // Fail fast on an unknown agent (honest 404, no side effects) before any
    // upstream work; undefined keeps the pre-agent behavior (agentId null).
    const agentId = this.resolveAgentId(body.agentId, cid);
    const payload: Record<string, unknown> = { location: { directory: project.directory } };
    if (body.title !== undefined) payload.title = body.title;
    if (body.parentID !== undefined) payload.parentID = body.parentID;
    if (body.model !== undefined) {
      payload.model = {
        id: body.model.id,
        providerID: body.model.providerID,
        ...(body.model.variant !== undefined ? { variant: body.model.variant } : {}),
      };
    }
    try {
      const client = await this.sdk.create(userId, cid);
      const active = await this.activeSessionIds(client, cid);
      const headers: Record<string, string> = {
        ...serveBasicAuthHeader(),
        'content-type': 'application/json',
      };
      if (cid) headers['x-correlation-id'] = cid;
      const res = await this.opencode.fetchWithRetry(
        `${this.opencode.dialUrl()}/api/session`,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        { operation: 'sessionsCreate' },
      );
      if (!res.ok) {
        // Drain before mapping (fixed messages only — the upstream body is
        // never logged nor echoed).
        await res.arrayBuffer().catch(() => null);
        throw this.upstreamError('sessionsCreate', new Error(`status_${res.status}`), res.status);
      }
      const json = (await res.json()) as UpstreamEnvelope<UpstreamSession>;
      if (!json || typeof json !== 'object' || !json.data || typeof json.data !== 'object') {
        throw this.upstreamError('sessionsCreate', new Error('bad_create_shape'));
      }
      this.logger.info('[sessions] created', cid);
      const created = this.toSessionInfo(
        json.data,
        project.projectId,
        active,
        agentId ?? null,
      );
      // The upstream row carries no agent — the durable store overlays it so
      // the answered row (and every later list after a restart) is never
      // missing the key (contract: nullable, never absent).
      if (agentId !== undefined) {
        await this.history.setAgent(created.id, project.projectId, agentId);
      }
      return created;
    } catch (err) {
      // Gate/validation stays honest (never a local session): Nest HTTP throws
      // (C4 404, real-user 401) propagate unmapped. A Postgres outage from the
      // agent upsert is already a 503 — never reinterpret it as an unreachable
      // stand.
      if (err instanceof HttpException) throw err;
      if (err instanceof ExternalServiceError && err.service === 'db') throw err;
      // Serve stand unreachable: the harness owns the session itself (same
      // domain shape, gate-bound project, idle until the first direct turn).
      // Upstream request-level 4xx keep their honest mapping — only transport
      // failures land here.
      const mapped = this.upstreamError('sessionsCreate', err);
      const code = (mapped as unknown as { code?: unknown }).code;
      if (code === 'EXTERNAL_BAD_REQUEST' || code === 'EXTERNAL_NOT_FOUND') throw mapped;
      this.markRunnerDown();
      const local: SessionInfo = {
        id: Bun.randomUUIDv7(),
        title: body.title ?? null,
        createdAt: new Date().toISOString(),
        directory: project.directory,
        projectId: project.projectId,
        model: body.model ?? null,
        agentId: agentId ?? null,
        status: { type: 'idle' },
      };
      // Durable registry row (origin='harness') so a backend restart keeps
      // the session; the agent choice gets its own row.
      await this.history.saveLocalSession(local);
      if (agentId !== undefined) {
        await this.history.setAgent(local.id, project.projectId, agentId);
      }
      this.logger.warn('[sessions] created in harness store', cid);
      this.logger.debug((err as Error).message, cid);
      return local;
    }
  }

  /**
   * Upstream message variant → domain SessionMessage. `text` is the
   * chat-visible projection: the variant's own `text` (user/system/
   * synthetic) or the assistant's `content[]` text parts joined — null for
   * every other variant (their nesting is not consumed and never faked).
   */
  private toSessionMessage(m: UpstreamMessage): SessionMessage {
    let text: string | null = null;
    if (typeof m.text === 'string' && m.text.length > 0) {
      text = m.text;
    } else if (Array.isArray(m.content)) {
      const parts = m.content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text.length > 0)
        .map((p) => p.text as string);
      if (parts.length > 0) text = parts.join('\n\n');
    }
    return {
      id: m.id,
      type: m.type,
      createdAt: new Date(m.time.created).toISOString(),
      text,
    };
  }

  /**
   * GET /api/v1/sessions/{id}/messages — v2 message list (GET
   * /api/session/{sessionID}/message) scoped through the C4 gate, the
   * {data,cursor} envelope unwrapped to a normalized array. `limit`/
   * `cursor` are the upstream-optional pagination params (artifact params
   * list), passed through unchanged.
   */
  async listMessages(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    limitRaw: string | undefined,
    cursor: string | undefined,
    cid: string,
  ): Promise<Array<SessionMessage>> {
    await this.access.resolveProjectDirectory(projectId, userId, cid);
    // Durable history first: direct turns never reach the serve stand, and
    // the rows must survive a backend restart (previously process memory).
    const stored = await this.history.listMessages(sessionId);
    const client = await this.sdk.create(userId, cid);
    try {
      const limit = this.parseLimit(limitRaw);
      const res = await client.v2.session.messages({
        sessionID: sessionId,
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!this.isUpstreamOk(res.data, res.error)) {
        throw this.upstreamError('sessionMessages', res.error, this.sdkStatus(res));
      }
      const rows = (res.data as unknown as UpstreamEnvelope<Array<UpstreamMessage>>).data ?? [];
      return this.mergeMessages(rows.map((m) => this.toSessionMessage(m)), stored);
    } catch (err) {
      // Our own validation + the gate keep their identity (400 bad_request /
      // gate HTTP — never mapped to EXTERNAL_* and never served from the store).
      if (err instanceof HttpException) throw err;
      // Request-level answers (401/404/400) stay honest; only a real runner
      // outage/timeout falls back to the durable store.
      if (
        err instanceof ExternalServiceError &&
        err.code !== 'EXTERNAL_UNAVAILABLE' &&
        err.code !== 'EXTERNAL_TIMEOUT'
      ) {
        throw err;
      }
      // The runner is legacy; the durable store is the source of truth — an
      // empty thread is honest. Serve the durable rows (same domain shape)
      // instead of failing whenever the runner is unavailable.
      this.logger.warn('[sessions] messages served from durable store', cid);
      this.logger.debug((err as Error).message, cid);
      this.markRunnerDown();
      return stored;
    }
  }

  /**
   * Upstream rows + durable rows → one ascending thread, de-duplicated by
   * message id (upstream wins on the unlikely overlap). Direct turns exist
   * only in the durable store; serve turns only upstream.
   */
  private mergeMessages(
    upstream: Array<SessionMessage>,
    stored: Array<SessionMessage>,
  ): Array<SessionMessage> {
    const byId = new Map<string, SessionMessage>();
    for (const row of upstream) byId.set(row.id, row);
    for (const row of stored) if (!byId.has(row.id)) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * POST /api/v1/sessions/{id}/messages — prompt the session's agent (direct
   * agent turn when a per-user key exists, otherwise queued on the serve
   * stand while it lives — see sendMessageDirect / sendMessageViaServe).
   * `text` is the prompt's only required payload field; files/skills/
   * delivery stay unexposed until a consumer exists. `model` (same
   * SessionInfoModel ref as on create) is accepted for backward compat but
   * ignored on both paths (the agent owns its model; the upstream prompt
   * rejects it). `agentId` selects the answering agent for this turn
   * (validated up front — unknown ids fail loud before any transport work);
   * without it the session keeps its stored agent (default 'ask'). The 200
   * receipt is projected to the domain message form (queued user row); the
   * answer itself streams over events.
   */
  async sendMessage(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage> {
    await this.access.resolveProjectDirectory(body.projectId, userId, cid);
    // Same real-user gate OpencodeSdkClient.create applies (the serve path
    // posts below the generator, so assert it here explicitly).
    this.auth.assertServeUser(userId, cid);
    // Fail fast on an unknown agent (honest 404, no side effects) before any
    // transport work — both the direct agent turn and the serve fallback
    // share this gate; undefined keeps the session/default resolution.
    this.resolveAgentId(body.agentId, cid);
    // Transport selection (explicit, user-sanctioned): a stored per-user Zen
    // key answers through the direct runner (no serve stand needed); without
    // a key (404 opencode_key_missing) the prompt queues on the serve stand
    // while it lives (legacy path — the e2e stub exercises exactly this).
    if (this.runner) {
      try {
        return await this.sendMessageDirect(userId, sessionId, body, cid);
      } catch (err) {
        if (!isMissingKey(err)) throw err;
        this.logger.warn('[sessions] direct runner skipped code=opencode_key_missing', cid);
      }
    }
    return this.sendMessageViaServe(sessionId, body, cid);
  }

  /**
   * Direct turn: the answer comes from the session's agent (AgentsService —
   * sessions→agents DI edge; the Ask agent answers through the
   * harness-owned runner behind the caller's key, so its model guard and
   * timeouts are preserved, no mock). The receipt keeps the domain shape;
   * both turns land in the durable Postgres history (survives restart) and
   * the token frames stay in the live SSE buffer, so history/SSE serve them
   * without the stand. A late answer after interrupt() is dropped (the
   * partial commit already belongs to stop()).
   *
   * Agent resolution: explicit per-turn agentId wins (validated against the
   * registry, honest 404 otherwise — never a fallback), then the session's
   * stored agent, then the default 'ask'. The resolved agent is stored back
   * on the session so SessionInfo.agentId always answers the truth. NOTE:
   * `body.model` is accepted by the domain signature for backward compat
   * but is intentionally ignored on the agent path (the agent owns its
   * model) — same stance as the serve path below.
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
    // Explicit per-turn agentId wins, then the durable stored agent (survives
    // restart), then the default. Reading the store is a DB call → 503 on
    // outage, never a silent memory fallback.
    const agentId =
      this.resolveAgentId(body.agentId, cid) ??
      (await this.history.getAgent(sessionId)) ??
      'ask';
    // An explicit per-turn agent becomes the session's stored agent.
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
    // Pre-allocated assistant identity for the token frames below.
    const assistantId = Bun.randomUUIDv7();
    try {
      // Ask answers whole (no progressive deltas) — the turn therefore
      // chunks into delta slices + the absolute snapshot (the same fallback
      // path a non-streamed runner answer always took). Buffer helpers
      // (bufferDirectDelta/Snapshot/Frames) and the session.idle terminator
      // below stay untouched.
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
      // The answer joins the durable thread before it streams to the client,
      // so a reload during the tail still reads the full history.
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
      // Terminal session.idle so the client send() finalizes (useChat
      // frameText:152 + send():444). Success path only — the direct-error
      // path already clears client sending via the failed POST itself, so no
      // idle there to avoid noise.
      this.bufferDirectIdle(sessionId);
      this.logger.info('[sessions] prompt answered directly', cid);
      return receipt;
    } catch (err) {
      // Missing per-user key: the direct transport never started, so the
      // staged receipt is discarded — the serve fallback (sendMessage) owns
      // the durable row, and keeping both would duplicate the message.
      if (isMissingKey(err)) {
        await this.history.discardMessage(receipt.id);
        throw err;
      }
      // Postgres outage from the durable history write — keep its honest 503.
      if (err instanceof ExternalServiceError && err.service === 'db') throw err;
      this.logger.warn('[sessions] direct prompt failed', cid);
      this.logger.debug((err as Error).message, cid);
      // Nest HTTP (missing/invalid key) keeps its billing-compatible code;
      // only transport failures map to the EXTERNAL_* envelope.
      if (err instanceof HttpException) throw err;
      throw fromUnknown('zen', 'sessionPromptDirect', err);
    } finally {
      this.busyDirect.delete(sessionId);
    }
  }

  /**
   * One progressive delta frame under a pre-allocated assistant/part identity
   * (Fix B sink for the runner's stream:true onDelta — the SSE tail no longer
   * waits for the full answer). The absolute snapshot still lands once via
   * bufferDirectSnapshot after the turn completes.
   */
  private bufferDirectDelta(
    sessionId: string,
    messageId: string,
    partID: string,
    delta: string,
  ): void {
    if (!delta) return;
    this.localFrames.push({
      id: Bun.randomUUIDv7(),
      type: 'message.part.delta',
      data: { sessionID: sessionId, messageID: messageId, partID, field: 'text', delta },
    });
    while (this.localFrames.length > 500) this.localFrames.shift();
  }

  /**
   * Absolute snapshot frame for a turn whose deltas already tailed
   * progressively (same message.part.updated envelope the frontend parses —
   * no client change).
   */
  private bufferDirectSnapshot(sessionId: string, assistant: SessionMessage): void {
    const text = assistant.text ?? '';
    if (!text) return;
    this.localFrames.push({
      id: Bun.randomUUIDv7(),
      type: 'message.part.updated',
      data: { sessionID: sessionId, part: { id: `prt_${assistant.id}`, type: 'text', text } },
    });
    while (this.localFrames.length > 500) this.localFrames.shift();
  }

  /**
   * Terminal frame for a completed direct turn: the frontend useChat send()
   * finalizes (clears sending) only on session.idle (frameText useChat.ts:152
   * + send():444), and the direct harness otherwise emits only
   * message.part.delta + message.part.updated — so without this the client
   * sending flag hangs until a manual stop(). Same envelope shape as the
   * delta/snapshot buffers (data.sessionID → toStreamFrame hoists top-level
   * session, merged localSessionIds filter passes it).
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

  private async sendMessageViaServe(
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage> {
    const headers: Record<string, string> = {
      ...serveBasicAuthHeader(),
      'content-type': 'application/json',
    };
    if (cid) headers['x-correlation-id'] = cid;
    try {
      const promptBody: Record<string, unknown> = { text: body.text };
      // NOTE: upstream /api/session/{id}/prompt does NOT accept a `model`
      // field (additionalProperties: false per contracts/opencode-stand-2.2.0.json).
      // The model is pinned at session creation time (POST /api/session body
      // accepts Model.Ref). Sending it here would be rejected (400) or
      // silently ignored — never do it. `body.model` is accepted by the
      // domain signature for backward compat but is intentionally dropped.
      void body.model;
      const res = await this.opencode.fetchWithRetry(
        `${this.opencode.dialUrl()}/api/session/${encodeURIComponent(sessionId)}/prompt`,
        { method: 'POST', headers, body: JSON.stringify(promptBody) },
        { operation: 'sessionPrompt' },
      );
      if (!res.ok) {
        await res.arrayBuffer().catch(() => null);
        throw this.upstreamError('sessionPrompt', new Error(`status_${res.status}`), res.status);
      }
      const json = (await res.json()) as UpstreamEnvelope<UpstreamInboxUser>;
      if (!json || typeof json.data !== 'object' || json.data === null) {
        throw this.upstreamError('sessionPrompt', new Error('bad_prompt_shape'));
      }
      const receipt = json.data;
      this.logger.info('[sessions] prompt accepted', cid);
      return {
        id: receipt.id,
        type: receipt.type,
        createdAt: new Date(receipt.time.created).toISOString(),
        text:
          typeof receipt.payload?.text === 'string' && receipt.payload.text.length > 0
            ? receipt.payload.text
            : null,
      };
    } catch (err) {
      this.logger.warn('[sessions] prompt failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('sessionPrompt', err);
    }
  }

  /**
   * Translate one upstream v2 event frame into our domain SSE frame:
   * {id, type, data} passthrough + `session` hoisted from the variant's
   * data.sessionID — provenance: artifact eventFrames.usedVariants carry
   * sessionID at the data top level in EVERY session-scoped variant
   * (message.part.*, session.*, permission.*); deeper part/info nesting is
   * NOT spec'd (Session.Info carries `id`, not `sessionID`) and is never
   * probed — no invented wire fields. Upstream top-level extras
   * (metadata/durable/location) are NOT part of the domain frame and are
   * dropped; `data` stays variant-owned (envelope-only decision from card
   * 3 — the ~100-variant union is never invented here). Values pass through
   * unstringified so a malformed upstream frame fails CLIENT-side parsing
   * instead of being papered over with defaults.
   */
  private toStreamFrame(value: unknown): Record<string, unknown> {
    const frame = value as { id?: unknown; type?: unknown; data?: unknown } | null;
    const data =
      frame && typeof frame.data === 'object' && frame.data !== null
        ? (frame.data as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = { id: frame?.id, type: frame?.type, data };
    const session = typeof data.sessionID === 'string' ? data.sessionID : undefined;
    if (session) out.session = session;
    return out;
  }

  /**
   * GET /api/v1/sessions/events — SSE re-stream of the v2 event bus (flat
   * frames) translated via toStreamFrame, MERGED with the harness-owned
   * direct-runner buffer. The C4 gate decides WHO may stream; the bus itself
   * is server-global, so the frame filter narrows delivery to sessions of
   * the gated project.
   *
   * Why merged: direct-runner turns are unknown to the serve stand, so the
   * live-only path filtered them out and the stream hung with zero frames
   * (the answer still landed in harness memory — visible after reload). The
   * harness-known sessions (localSessionIds) therefore stream from the local
   * buffer INDEPENDENTLY of the stand: replay of the buffered frames first,
   * then a live tail of newly appended frames while the turn is busy or
   * inside the idle window. The live stand subscription stays for non-local
   * sessions (its frames for harness-owned ids are dropped at the merge so
   * they never double). Everything rides the shared relaySse (subscribe owns
   * the merged async-iterable; mapFrame stays toStreamFrame).
   *
   * Merge/tail boundaries: the stream ends on downstream close (relaySse
   * aborts the signal), on the local idle timeout (no busy direct turn AND
   * no new local frame for LOCAL_IDLE_MS), or on the overall STREAM_CAP_MS.
   * Compromise, stated honestly: the buffer is finite and shared, so a
   * client redial replays whatever is still buffered (dupes possible) —
   * full content always remains available via history.
   *
   * The id set is a snapshot taken ONCE per stream (never re-listed per
   * frame) and then maintained incrementally: `session.created` adds a
   * session whose `location.directory` equals the project's jailed directory,
   * `session.deleted` removes it. A project that had zero sessions at
   * subscribe time therefore starts receiving its first session's frames.
   * Frames without a session are dropped. Shared relaySse mechanics:
   * probe-down before headers → honest 503; downstream close → abort +
   * quiet debug, no answer.
   */
  async streamEvents(
    userId: string,
    projectId: string | undefined,
    cid: string,
    req: ExpressRequest,
    res: ExpressResponse,
  ): Promise<void> {
    const project = await this.access.resolveProjectDirectory(projectId, userId, cid);
    // Harness-owned SSE scope: durable harness sessions + every session with
    // durable messages, both already project-scoped by the store.
    const localSessionIds = new Set<string>();
    for (const s of await this.history.listLocalSessions(project.projectId)) {
      localSessionIds.add(s.id);
    }
    for (const sid of await this.history.listSessionIdsWithMessages(project.projectId)) {
      localSessionIds.add(sid);
    }
    const hasLocal = localSessionIds.size > 0;
    // Live framing is best-effort when the harness owns turns: a transport
    // failure degrades to local-only, but gate/auth errors stay honest (the
    // old path never served memory to a caller who failed the gate). With no
    // harness state the strict live path below keeps the honest 503 (never
    // 200 silence).
    let liveClient: OpencodeClient | null = null;
    let rows: Array<SessionInfo> = [];
    if (hasLocal) {
      try {
        liveClient = await this.sdk.create(userId, cid);
      } catch (err) {
        if (err instanceof HttpException) throw err;
        liveClient = null;
      }
      if (liveClient) {
        try {
          rows = await this.listWithClient(liveClient, project, cid);
        } catch {
          // Stand unreachable mid-list — the local tail below still serves
          // the harness-owned turns; the live subscribe retries the same way.
          rows = [];
        }
      }
    } else {
      liveClient = await this.sdk.create(userId, cid);
      rows = await this.listWithClient(liveClient, project, cid);
    }
    const allowedSessions = new Set(rows.map((row) => row.id));
    // Live refs for the merge closure (same array/set identity — appends and
    // the busyDirect override stay visible to the running generator).
    const frames = this.localFrames;
    const busy = this.busyDirect;
    const stand = liveClient;
    await relaySse({
      operation: 'GET /api/v1/sessions/events',
      cid,
      req,
      res,
      logger: this.logger,
      prefix: '[sessions]',
      probe: hasLocal ? async () => 'up' as const : () => this.opencode.checkConnectivity(),
      unreachableError: () => this.upstreamError('sessionEvents', new Error('unreachable')),
      subscribeFailedError: (err) => this.upstreamError('sessionEvents', err),
      subscribe: async (signal) => {
        const replay = frames.filter((f) => {
          const sid = typeof f.data.sessionID === 'string' ? f.data.sessionID : undefined;
          return sid !== undefined && localSessionIds.has(sid);
        });
        let cursor = frames.length;
        let liveIt: AsyncIterator<unknown> | null = null;
        if (stand) {
          try {
            const sub = (await stand.v2.event.subscribe({
              signal,
              sseDefaultRetryDelay: 500,
              sseMaxRetryDelay: 2000,
            })) as unknown as {
              stream: AsyncIterable<unknown> & { return?: (v?: unknown) => Promise<unknown> };
            };
            liveIt = sub.stream[Symbol.asyncIterator]();
          } catch {
            // Stand unreachable mid-handshake — local-only tail below.
            liveIt = null;
          }
        }
        const startedAt = Date.now();
        let lastLocalAt = Date.now();
        const LOCAL_IDLE_MS = 30_000;
        const STREAM_CAP_MS = 300_000;
        const POLL_MS = 250;
        const stream = (async function* (): AsyncGenerator<unknown> {
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
                lastLocalAt = Date.now();
                yield f;
              }
            }
            if (liveIt) {
              const next = await Promise.race([
                liveIt.next(),
                new Promise<null>((resolve) => {
                  setTimeout(() => resolve(null), POLL_MS);
                }),
              ]);
              if (signal.aborted) return;
              if (next === null) {
                // No live frame this poll — fall through to idle/cap check.
              } else if (next.done) {
                liveIt = null; // upstream ended — tail the harness buffer only
              } else {
                // Live stand frames for harness-owned sessions are dropped
                // here (the local tail above owns them) so they never double.
                const raw = next.value as { data?: unknown } | null;
                const data =
                  raw && typeof raw.data === 'object' && raw.data !== null
                    ? (raw.data as Record<string, unknown>)
                    : {};
                const sid = typeof data.sessionID === 'string' ? data.sessionID : undefined;
                if (sid === undefined || !localSessionIds.has(sid)) yield next.value;
                continue;
              }
            } else {
              await new Promise((resolve) => setTimeout(resolve, POLL_MS));
              if (signal.aborted) return;
            }
            if (Date.now() - startedAt > STREAM_CAP_MS) return;
            let busyLocal = false;
            for (const sid of localSessionIds) {
              if (busy.has(sid)) {
                busyLocal = true;
                break;
              }
            }
            if (!busyLocal && Date.now() - lastLocalAt > LOCAL_IDLE_MS) return;
          }
        })();
        return { stream };
      },
      filterFrame: (frame) => {
        const f = frame as { type?: unknown; data?: unknown; session?: unknown } | null;
        const type = typeof f?.type === 'string' ? f.type : '';
        const data =
          f && typeof f.data === 'object' && f.data !== null
            ? (f.data as Record<string, unknown>)
            : {};
        const sessionId = typeof data.sessionID === 'string' ? data.sessionID : undefined;
        const infoId = typeof data.id === 'string' ? data.id : undefined;
        if (type === 'session.created') {
          const location = data.location as { directory?: unknown } | undefined;
          // Ownership = the jailed directory the project gate resolved.
          if (location?.directory === project.directory) {
            if (sessionId) allowedSessions.add(sessionId);
            if (infoId) allowedSessions.add(infoId);
          }
        } else if (type === 'session.deleted') {
          if (sessionId) allowedSessions.delete(sessionId);
          if (infoId) allowedSessions.delete(infoId);
        }
        const session =
          typeof f?.session === 'string'
            ? f.session
            : type === 'session.created'
              ? (sessionId ?? infoId)
              : undefined;
        if (typeof session !== 'string') return false;
        // Harness-owned turns stream from the local tail (replay + live tail
        // above) — always in scope for the gated project that owns them.
        if (localSessionIds.has(session)) return true;
        return allowedSessions.has(session);
      },
      mapFrame: (value) => this.toStreamFrame(value),
    });
  }

  /**
   * POST /api/v1/sessions/{id}/interrupt — v2 interrupt (POST
   * /api/session/{sessionID}/interrupt) via the sdk client. No body: the
   * artifact declares none (the stub asserts its absence). The pinned
   * generator still types the answer as 204 void while the live 2.2.0 spec
   * answers 200 {interrupted} (provenance: artifact interrupt path) — the
   * runtime parses the JSON body either way, so the shape check below reads
   * the cast data instead of the stale type. The `resume` query knob exists
   * upstream but has no UI consumer — deliberately unexposed. The upstream
   * {interrupted} is the honest domain answer (false = idle no-op, never
   * an error).
   */
  async interrupt(
    userId: string,
    sessionId: string,
    body: InterruptSessionInput,
    cid: string,
  ): Promise<SessionInterruptResult> {
    await this.access.resolveProjectDirectory(body.projectId, userId, cid);
    // A direct turn marks itself interrupted here; its late answer is dropped
    // in sendMessageDirect (the partial commit already belongs to stop()).
    const localInterrupted = this.busyDirect.delete(sessionId);
    // Guarantee the hanging client sending flag clears even if the terminal
    // session.idle was lost: a redundant idle while sendingRef=false is
    // dropped client-side, so this is safe.
    if (localInterrupted) this.bufferDirectIdle(sessionId);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.v2.session.interrupt({ sessionID: sessionId });
      if (!this.isUpstreamOk(res.data, res.error)) {
        throw this.upstreamError('sessionInterrupt', res.error, this.sdkStatus(res));
      }
      const json = res.data as unknown as { interrupted?: unknown };
      if (!json || typeof json.interrupted !== 'boolean') {
        throw this.upstreamError('sessionInterrupt', new Error('bad_interrupt_shape'));
      }
      this.logger.info('[sessions] interrupted', cid);
      return { interrupted: json.interrupted || localInterrupted };
    } catch (err) {
      this.logger.warn('[sessions] interrupt failed', cid);
      this.logger.debug((err as Error).message, cid);
      const mapped = this.upstreamError('sessionInterrupt', err);
      // Stand does not know the session but we did interrupt a direct turn.
      if (
        localInterrupted &&
        (mapped as unknown as { code?: unknown }).code === 'EXTERNAL_NOT_FOUND'
      ) {
        this.logger.info('[sessions] interrupted locally', cid);
        return { interrupted: true };
      }
      throw mapped;
    }
  }

  /**
   * GET /api/v1/sessions/providers — the project's runner provider inventory
   * (v2 GET /api/provider in the gated jail, the same sdk call the removed
   * mirror made). The domain row is the REQUIRED artifact subset
   * (Provider.Info: id/name/activation/package); settings/headers/body are
   * never projected (headers can carry auth material; the UI consumes
   * none of it). A row violating the required set fails loud — never a
   * silently skipped or defaulted row.
   */
  async providers(userId: string, projectId: string | undefined, cid: string): Promise<Array<SessionRunnerProvider>> {
    const project = await this.access.resolveProjectDirectory(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.v2.provider.list({ location: { directory: project.directory } });
      if (!this.isUpstreamOk(res.data, res.error)) {
        throw this.upstreamError('sessionProviders', res.error, this.sdkStatus(res));
      }
      const env = res.data as unknown as UpstreamProviderEnvelope;
      const rows = Array.isArray(env?.data) ? (env.data as Array<UpstreamProviderInfo>) : null;
      if (!rows) throw this.upstreamError('sessionProviders', new Error('bad_providers_shape'));
      return rows.map((p) => {
        if (
          typeof p.id !== 'string' ||
          p.id.length === 0 ||
          typeof p.name !== 'string' ||
          typeof p.package !== 'string' ||
          !isProviderActivation(p.activation)
        ) {
          throw this.upstreamError('sessionProviders', new Error('bad_provider_row'));
        }
        return { id: p.id, name: p.name, activation: p.activation, package: p.package };
      });
    } catch (err) {
      this.logger.warn('[sessions] providers list failed', cid);
      this.logger.debug((err as Error).message, cid);
      if (
        this.isRunnerDown() &&
        err instanceof ExternalServiceError &&
        (err.code === 'EXTERNAL_UNAVAILABLE' || err.code === 'EXTERNAL_TIMEOUT')
      ) {
        this.logger.warn('[sessions] providers served empty (runner unavailable)', cid);
        return [];
      }
      throw this.upstreamError('sessionProviders', err);
    }
  }

  /**
   * GET /api/v1/sessions/models — runner model inventory filtered to the
   * OpenCode Go/Zen family (provider id opencode / opencode-go / opencode-zen).
   * Rides the sdk `client.v2.model.list` (same {location, data} envelope as
   * the provider inventory above) scoped to the gated jail.
   */
  async models(userId: string, projectId: string | undefined, cid: string): Promise<Array<{ id: string; name: string; providerID: string }>> {
    const project = await this.access.resolveProjectDirectory(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.v2.model.list({ location: { directory: project.directory } });
      if (!this.isUpstreamOk(res.data, res.error)) {
        throw this.upstreamError('sessionModels', res.error, this.sdkStatus(res));
      }
      const env = res.data as unknown as { data?: unknown };
      const rows = Array.isArray(env?.data) ? (env.data as Array<Record<string, unknown>>) : null;
      if (!rows) throw this.upstreamError('sessionModels', new Error('bad_models_shape'));
      const out: Array<{ id: string; name: string; providerID: string }> = [];
      for (const r of rows) {
        const providerID = typeof r.providerID === 'string' ? r.providerID : '';
        if (!['opencode', 'opencode-go', 'opencode-zen'].includes(providerID)) continue;
        const modelID = typeof r.modelID === 'string' ? r.modelID : (typeof r.id === 'string' ? r.id : '');
        const name = typeof r.name === 'string' ? r.name : modelID;
        if (!modelID) throw this.upstreamError('sessionModels', new Error('bad_model_row'));
        out.push({ id: modelID, name, providerID });
      }
      this.logger.info('[sessions] models listed', cid);
      return out;
    } catch (err) {
      this.logger.warn('[sessions] models list failed', cid);
      this.logger.debug((err as Error).message, cid);
      if (
        this.isRunnerDown() &&
        err instanceof ExternalServiceError &&
        (err.code === 'EXTERNAL_UNAVAILABLE' || err.code === 'EXTERNAL_TIMEOUT')
      ) {
        this.logger.warn('[sessions] models served empty (runner unavailable)', cid);
        return [];
      }
      throw this.upstreamError('sessionModels', err);
    }
  }
}
