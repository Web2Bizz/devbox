import { BadRequestException, Injectable } from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { OrganizationsService } from '../../../organizations/organizations.service';
import { ownerKeyOrThrow } from '../../../organizations/projects/projects.service';
import { WorkspacePathService } from '../../../common/storage/workspace-path.service';
import { OpencodeSdkClient } from '../opencode/opencode-sdk-client';
import { OpencodeService } from '../opencode/opencode.service';
import {
  ServeAuthService,
  serveBasicAuthHeader,
} from '../opencode/modules/auth/auth.service';
import { AppLogger } from '../../../common/logger';
import { relaySse } from '../../../common/sse/sse-relay';
import { fromStatus, fromUnknown } from '../../../common/external/external-error';
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

/**
 * SessionsService — the domain translation layer behind /api/sessions*.
 *
 * Owns the opencode → Rush Code vocabulary: the product contract is
 * SessionInfo (nullable title/model, ISO createdAt, `directory`,
 * our uuid `projectId`); everything opencode-shaped stays inside this
 * service. Transport reuses the exact building blocks the deprecated
 * /api/opencode/* mirror uses (no behavior change there):
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
 *   idle otherwise. The legacy GET /session/status the mirror proxies is
 *   not served by 2.x (SPA catch-all → 503), so deriving from the active
 *   map is the only REST-reachable source; the transient `retry` state
 *   lives in the event stream, not in snapshots. Interrupt and the model
 *   inventory ride the same sdk client (interrupt posts no body; the model
 *   list is scoped to the gated jail via the v2 location query).
 *
 * Error mapping is shared with the mirror semantics (external-error
 * fromStatus/fromUnknown): request-level upstream 4xx answer honest 400/
 * 404 EXTERNAL_BAD_REQUEST / EXTERNAL_NOT_FOUND (no Retry-After), real
 * outages stay 503 EXTERNAL_UNAVAILABLE + Retry-After. No fallbacks: no
 * projectId → 400 PROJECT_REQUIRED, no jailed dir → the gate error
 * propagates (never a cwd/default location), no upstream URL defaults.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly sdk: OpencodeSdkClient,
    private readonly opencode: OpencodeService,
    private readonly orgs: OrganizationsService,
    private readonly paths: WorkspacePathService,
    private readonly auth: ServeAuthService,
    private readonly logger: AppLogger = new AppLogger('SessionsService'),
  ) {}

  /** Same non-negative-integer query guard the mirror uses for ?limit. */
  private parseLimit(limitRaw?: string): number | undefined {
    if (limitRaw === undefined) return undefined;
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new BadRequestException('Query "limit" must be a non-negative integer');
    }
    return limit;
  }

  /**
   * C4 project gate + directory jail — the same fail-closed composition as
   * OpencodeController.requireProjectDir (gateway convention: each surface
   * composes OrganizationsService.assertProjectAccessById + WorkspacePath
   * itself; extraction to a shared helper is a follow-up, the semantics
   * here are identical and must not drift). Returns the narrowed projectId
   * (uuid the gate accepted) alongside the jailed content dir.
   */
  private async requireProject(
    projectId: string | undefined,
    userId: string,
    correlationId?: string,
  ): Promise<{ projectId: string; directory: string }> {
    if (!projectId || projectId.trim() === '') {
      throw new BadRequestException({
        code: 'PROJECT_REQUIRED',
        message: 'projectId is required — session routes are project-scoped',
      });
    }
    const { ownerId } = await this.orgs.assertProjectAccessById(
      projectId,
      userId,
      correlationId,
    );
    const resolved = await this.paths.resolveUserStrict(
      ownerKeyOrThrow(ownerId),
      projectId,
    );
    await this.paths.assertInsideJail(
      resolved.absRepo,
      await this.paths.realStrictRoot(),
    );
    return { projectId, directory: resolved.absRepo };
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
   * project hash) + derived status → domain SessionInfo. */
  private toSessionInfo(
    s: UpstreamSession,
    projectId: string,
    active: Set<string>,
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
      status,
    };
  }

  /** GET /api/sessions?projectId — list scoped to the gated jail. */
  async list(userId: string, projectId: string | undefined, cid: string): Promise<SessionInfo[]> {
    const project = await this.requireProject(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const [res, active] = await Promise.all([
        client.v2.session.list({ directory: project.directory }),
        this.activeSessionIds(client, cid),
      ]);
      if (!this.isUpstreamOk(res.data, res.error)) {
        throw this.upstreamError('sessionsList', res.error, this.sdkStatus(res));
      }
      const rows = (res.data as unknown as UpstreamEnvelope<UpstreamSession[]>).data ?? [];
      return rows.map((s) => this.toSessionInfo(s, project.projectId, active));
    } catch (err) {
      this.logger.warn('[sessions] list failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('sessionsList', err);
    }
  }

  /** GET /api/sessions/status?projectId — sessionId → derived runtime status. */
  async statusMap(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<SessionRunStatusMap> {
    const rows = await this.list(userId, projectId, cid);
    const map: SessionRunStatusMap = {};
    for (const row of rows) map[row.id] = row.status;
    return map;
  }

  /**
   * POST /api/sessions — create in the gated jail, honestly forwarding
   * title/parentID/model. The body is built non-empty ({location} always present)
   * because the 2.x create endpoint rejects a missing JSON object; it rides
   * fetchWithRetry (not the sdk) because the pinned generated create()
   * silently drops every field except id/agent/model/location.
   */
  async create(userId: string, body: CreateSessionInput, cid: string): Promise<SessionInfo> {
    const project = await this.requireProject(body.projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    const active = await this.activeSessionIds(client, cid);
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
    const headers: Record<string, string> = {
      ...serveBasicAuthHeader(),
      'content-type': 'application/json',
    };
    if (cid) headers['x-correlation-id'] = cid;
    try {
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
      return this.toSessionInfo(json.data, project.projectId, active);
    } catch (err) {
      this.logger.warn('[sessions] create failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('sessionsCreate', err);
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
   * GET /api/sessions/{id}/messages — v2 message list (GET
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
  ): Promise<SessionMessage[]> {
    await this.requireProject(projectId, userId, cid);
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
      const rows = (res.data as unknown as UpstreamEnvelope<UpstreamMessage[]>).data ?? [];
      return rows.map((m) => this.toSessionMessage(m));
    } catch (err) {
      this.logger.warn('[sessions] messages list failed', cid);
      this.logger.debug((err as Error).message, cid);
      // Our own query validation (parseLimit) keeps its 400 bad_request
      // identity — only upstream/transport failures map to EXTERNAL_*
      // (same guard as the mirror's listMessages).
      throw err instanceof BadRequestException ? err : this.upstreamError('sessionMessages', err);
    }
  }

  /**
   * POST /api/sessions/{id}/messages — v2 prompt (POST
   * /api/session/{sessionID}/prompt) via fetchWithRetry (the legacy
   * /session/{id}/message surface the mirror still rides is not served by
   * 2.x). `text` is the prompt's only required payload field (artifact
   * requestBody); files/agents/skills/delivery stay unexposed until a
   * consumer exists. `model` (same SessionInfoModel ref as on create) rides
   * the same prompt body when provided — without it the body is text-only
   * and the runner keeps the session model. The 200 `Session.Inbox.User`
   * receipt is projected to the domain message form (queued user row).
   */
  async sendMessage(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage> {
    await this.requireProject(body.projectId, userId, cid);
    // Same real-user gate OpencodeSdkClient.create applies (this path posts
    // below the generator, so assert it here explicitly).
    this.auth.assertServeUser(userId, cid);
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
   * GET /api/sessions/events — SSE re-stream of the v2 event bus (flat
   * frames) translated via toStreamFrame. The C4 gate decides WHO may
   * stream; the bus itself is server-global (like the mirror's /event),
   * `session` lets the client scope rows. Shared relaySse mechanics:
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
    await this.requireProject(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    await relaySse({
      operation: 'GET /api/sessions/events',
      cid,
      req,
      res,
      logger: this.logger,
      prefix: '[sessions]',
      probe: () => this.opencode.checkConnectivity(),
      unreachableError: () => this.upstreamError('sessionEvents', new Error('unreachable')),
      subscribeFailedError: (err) => this.upstreamError('sessionEvents', err),
      subscribe: (signal) =>
        client.v2.event.subscribe({
          signal,
          sseDefaultRetryDelay: 500,
          sseMaxRetryDelay: 2000,
        }) as unknown as Promise<{
          stream: AsyncIterable<unknown> & { return?: (v?: unknown) => Promise<unknown> };
        }>,
      mapFrame: (value) => this.toStreamFrame(value),
    });
  }

  /**
   * POST /api/sessions/{id}/interrupt — v2 interrupt (POST
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
    await this.requireProject(body.projectId, userId, cid);
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
      return { interrupted: json.interrupted };
    } catch (err) {
      this.logger.warn('[sessions] interrupt failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('sessionInterrupt', err);
    }
  }

  /**
   * GET /api/sessions/providers — the project's runner provider inventory
   * (v2 GET /api/provider in the gated jail, the same sdk call the mirror
   * makes). The domain row is the REQUIRED artifact subset
   * (Provider.Info: id/name/activation/package); settings/headers/body are
   * never projected (headers can carry auth material; the UI consumes
   * none of it). A row violating the required set fails loud — never a
   * silently skipped or defaulted row.
   */
  async providers(userId: string, projectId: string | undefined, cid: string): Promise<SessionRunnerProvider[]> {
    const project = await this.requireProject(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.v2.provider.list({ location: { directory: project.directory } });
      if (!this.isUpstreamOk(res.data, res.error)) {
        throw this.upstreamError('sessionProviders', res.error, this.sdkStatus(res));
      }
      const env = res.data as unknown as UpstreamProviderEnvelope;
      const rows = Array.isArray(env?.data) ? (env.data as UpstreamProviderInfo[]) : null;
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
      throw this.upstreamError('sessionProviders', err);
    }
  }

  /**
   * GET /api/sessions/models — runner model inventory filtered to the
   * OpenCode Go/Zen family (provider id opencode / opencode-go / opencode-zen).
   * Rides the sdk `client.v2.model.list` (same {location, data} envelope as
   * the provider inventory above) scoped to the gated jail.
   */
  async models(userId: string, projectId: string | undefined, cid: string): Promise<Array<{ id: string; name: string; providerID: string }>> {
    const project = await this.requireProject(projectId, userId, cid);
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
      throw this.upstreamError('sessionModels', err);
    }
  }
}
