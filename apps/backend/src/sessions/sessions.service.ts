import { BadRequestException, Injectable } from '@nestjs/common';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { OrganizationsService } from '../organizations/organizations.service';
import { ownerKeyOrThrow } from '../projects/projects.service';
import { WorkspacePathService } from '../workspaces/workspace-path.service';
import { OpencodeSdkClient } from '../opencode/opencode-client';
import { OpencodeService } from '../opencode/opencode.service';
import { serveBasicAuthHeader } from '../opencode-keys/opencode-auth.service';
import { AppLogger } from '../common/app-logger.service';
import { fromStatus, fromUnknown } from '../common/external/external-error';
import type {
  CreateSessionInput,
  SessionInfo,
  SessionInfoModel,
  SessionRunStatus,
  SessionRunStatusMap,
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
 * SessionsService — the domain translation layer behind /api/sessions*.
 *
 * Owns the opencode → Rush Code vocabulary: the product contract is
 * SessionInfo (nullable title/model, ISO createdAt, `directory`,
 * our uuid `projectId`); everything opencode-shaped stays inside this
 * service. Transport reuses the exact building blocks the deprecated
 * /api/opencode/* mirror uses (no behavior change there):
 * - reads (session list, active set) ride the v2 sdk surface through
 *   OpencodeSdkClient (real-user gate + ExternalClient retry/timeout);
 * - create posts through OpencodeService.fetchWithRetry directly with the
 *   server Basic header — the pinned sdk 1.18.33 generated create() sends
 *   only id/agent/model/location, so title/parentID need one transport
 *   layer below the generator (this closes the mirror's TODO(card 4)
 *   without touching the mirror route itself);
 * - status is DERIVED from live data (GET /api/session/active — the 2.x
 *   spec's running-drain map): busy while a session has an active drain,
 *   idle otherwise. The legacy GET /session/status the mirror proxies is
 *   not served by 2.x (SPA catch-all → 503), so deriving from the active
 *   map is the only REST-reachable source; the transient `retry` state
 *   lives in the event stream, not in snapshots.
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
    private readonly logger: AppLogger = new AppLogger('SessionsService'),
  ) {}

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
   * title/parentID. The body is built non-empty ({location} always present)
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
}
