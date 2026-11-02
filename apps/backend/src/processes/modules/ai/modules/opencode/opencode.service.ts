import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
// NOTE: v2 SDK (pinned 1.18.33, `./v2` subpath) — flat params
// (`{ sessionID, directory, ...body }`, signal via the 2nd options arg),
// NOT the v1 `{ path, body, query }` nesting. Reads (+ providers/sse)
// go through the v2 `/api/*` namespace (`client.v2.session/*`,
// `client.v2.provider`, `client.v2.event`) — the stand serves the API
// there, while the legacy `/session`, `/event`, `/config/providers`
// root answers SPA text/html (SDK throws `Server responded with
// text/html`). `session.create` already goes through the v2 namespace
// (`client.v2.session.create` → POST /api/session, body carries the gated
// project's `location.directory` — the legacy POST /session answers 405). Writes without a v2 equivalent
// (update/delete/fork/prompt/prompt_async/command/shell, status, abort,
// global.event)
// stay on the legacy `Session2`/`Config2`/`Event`/`Global` surface —
// the same paths the controller mirrors under `/api/opencode/*`.
import type { OpencodeClient, OutputFormat, Session, SessionV2Info } from '@opencode-ai/sdk/v2';
import { AppLogger } from '../../../../../common/logger';
import { ExternalClient } from '../../../../../common/external/external-client';
import { fromStatus, fromUnknown } from '../../../../../common/external/external-error';
import { relaySse, type SseSubscription } from '../../../../../common/sse/sse-relay';
import { ProjectAccessService } from '../../../../../organizations/modules/projects/modules/project-access/project-access.service';
import type {
  OpencodeCommandInput,
  OpencodeForkInput,
  OpencodePromptInput,
  OpencodeSessionUpdateInput,
  OpencodeShellInput,
} from '../../../../../common/http/api/api.dto';
import { OpencodeSdkClient } from './opencode-sdk-client';
import { OpencodeConfig } from './opencode.config';
import { serveBasicAuthHeader } from './modules/auth/serve-auth.service';

/** Upstream cursor headers passed through on GET message lists (when present). */
const CURSOR_PASSTHROUGH_HEADERS = ['x-next-cursor', 'link'] as const;

export type OpencodeStatus = 'up' | 'down';

/** Short probe budget for the liveness probe (GET /api/info) — must not wait on upstream. */
export const OPENCODE_HEALTH_TIMEOUT_MS = 2000;

/**
 * OpencodeService — single owner of the upstream opencode fetch (dial config
 * and REQUEST_TIMEOUT_MS budget come from OpencodeConfig).
 *
 * - Canonical `url` preserves an explicit 0.0.0.0 host verbatim
 *   (the stand listens on all interfaces; env assembly never rewrites it).
 * - `dialUrl()` remaps undialable 0.0.0.0 / :: → 127.0.0.1 for outbound
 *   requests only; localhost configs pass through untouched.
 * - `fetchWithTimeout()` is the shared single-attempt upstream fetch
 *   (AbortController + REQUEST_TIMEOUT_MS budget) used by health probing —
 *   routed through ExternalClient so attempts are logged uniformly.
 * - `fetchWithRetry()` adds bounded retry for idempotent (GET) upstream
 *   calls (429/5xx/timeout, EXTERNAL_RETRY_* tuning); POST/… still run once
 *   unless `allowNonIdempotentRetry` is passed explicitly.
 * - `checkConnectivity()` never throws and never logs secrets (the URL
 *   carries no credentials; only the error message is logged at debug).
 *   Liveness stays single-attempt — no retry budget on the probe.
 *
 * Behavior mirrors the former proxy: upstream failures (even after
 * the ExternalClient retry budget inside OpencodeSdkClient) throw
 * ExternalServiceError — the api-error.filter answers 503
 * EXTERNAL_UNAVAILABLE («сервис временно недоступен, повторите позже»)
 * with a Retry-After header for real outages (network/timeout/5xx). An
 * upstream 401/403 (the stand refused the credentials we sent) answers
 * 503 EXTERNAL_UNAUTHORIZED — a distinct code, no Retry-After (a retry
 * with the same credentials cannot help). Request-level 4xx are never
 * masked as outages: upstream 400/422 answer 400/422 EXTERNAL_BAD_REQUEST
 * and upstream 404 answers 404 EXTERNAL_NOT_FOUND — both non-retryable,
 * both without Retry-After. No mock 200s: a 200 always means live upstream
 * data (warn + debug via AppLogger, never logs secrets — no URLs/headers/
 * bodies).
 *
 * Auth: every upstream route except GET global/health requires JwtAuthGuard
 * (@ReqUser() identity → real-user gate: non-uuid mock → 401
 * `unauthorized`); upstream auth is the server Basic password
 * (OPENCODE_PASSWORD, unset → no header, upstream 401). There is NO
 * per-user DB Bearer and NO env token fallback on this path. GET
 * global/health stays anonymous FROM THE BROWSER (no JwtAuthGuard —
 * liveness probe) but the probe to the upstream carries the server
 * Basic credentials like every other serve call — the live 2.x stand
 * answers 401 to an anonymous /api/info; credentials are the backend's
 * responsibility, not the caller's. The route is SYNTHESIZED from the v2
 * liveness endpoint GET /api/info — the 2.x upstream spec has no
 * /global/health (the path answers the SPA index).
 *
 * Project scope (Card C4): every session/message/provider route requires a
 * `?projectId` and gates through
 * ProjectAccessService.assertProjectAccessById BEFORE any upstream call
 * (org-linked → member, user-space → owner; strangers → 404, no existence
 * leak; missing projectId → 400 PROJECT_REQUIRED). The caller's `?directory`
 * is accepted for compatibility but IGNORED — upstream calls that take a
 * directory always use the gated project's jailed content dir
 * (ProjectAccessService.resolveProjectDirectory — WorkspacePathService
 * .resolveUserStrict + assertInsideJail inside; unconfigured storage fails
 * closed). v2 calls without a directory parameter ride the
 * gate only (documented per route). The SSE event streams (`global/event`,
 * `event`) and GET `global/health` stay project-free (global surfaces, no
 * session :id) — recorded remainder, not an exception for session reads.
 *
 * Serve auth is untouched: JwtAuthGuard + @ReqUser() + ServeAuthService
 * real-user gate + serveBasicAuthHeader (server Basic) behave exactly as
 * before — only auth=yes|no presence is traced, never secrets.
 */
@Injectable()
export class OpencodeService {
  private readonly external: ExternalClient;
  private readonly cfg: OpencodeConfig;

  constructor(
    @Optional() config?: ConfigService,
    private readonly logger: AppLogger = new AppLogger(OpencodeService.name),
    @Optional() private readonly externalClient?: ExternalClient,
    private readonly sdkClient?: OpencodeSdkClient,
    private readonly access?: ProjectAccessService,
    @Optional() private readonly opencodeConfig?: OpencodeConfig,
  ) {
    this.external = this.externalClient ?? new ExternalClient(new AppLogger(OpencodeService.name));
    // Direct construction (specs) skips DI — fall back to a config bound to
    // the same optional ConfigService.
    this.cfg = opencodeConfig ?? new OpencodeConfig(config);
  }

  /** Canonical opencode URL, no trailing slash, explicit 0.0.0.0 preserved. */
  get url(): string {
    return this.cfg.baseUrl;
  }

  get host(): string {
    try {
      return new URL(this.url).hostname;
    } catch {
      // readonly-исключение: оборонительный парс-дефолт (url уже валидирован в
      // resolved()/validateEnv в OpencodeConfig — ветка практически недостижима); чтение, не запись.
      return 'localhost';
    }
  }

  get port(): number {
    try {
      const p = Number(new URL(this.url).port);
      return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 4096;
    } catch {
      // readonly-исключение: см. host выше — оборонительный дефолт парсинга.
      return 4096;
    }
  }

  get protocol(): 'http' | 'https' {
    try {
      return new URL(this.url).protocol === 'https:' ? 'https' : 'http';
    } catch {
      // readonly-исключение: см. host выше — оборонительный дефолт парсинга.
      return 'http';
    }
  }

  get timeoutMs(): number {
    return this.cfg.timeoutMs;
  }

  /**
   * Delegates to OpencodeConfig.dialUrl() (0.0.0.0 / :: → 127.0.0.1 for
   * outbound dialing; the configured `url` getter keeps 0.0.0.0 verbatim).
   */
  dialUrl(): string {
    return this.cfg.dialUrl();
  }

  async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<Response> {
    const budget = timeoutMs ?? this.timeoutMs;
    try {
      return await this.external.fetchWithRetry(
        url,
        init,
        {
          service: 'opencode',
          operation: 'fetch',
          timeoutMs: budget,
          // Single attempt — same semantics as the old AbortController fetch;
          // retry lives in fetchWithRetry() for idempotent callers.
          retry: { maxAttempts: 1 },
        },
      );
    } catch (err) {
      // ExternalClient throws only when no response exists (network/timeout);
      // translate back to the historical throw shape (AbortError-aware
      // callers check `.name`) without leaking internals.
      const asError = err instanceof Error ? err : new Error(String(err));
      throw asError;
    }
  }

  /**
   * Bounded-retry upstream fetch for idempotent calls. Non-idempotent
   * methods run exactly once unless `allowNonIdempotentRetry` is true.
   * Resolves with the upstream Response (even non-ok); throws
   * ExternalServiceError only when no response exists.
   */
  fetchWithRetry(
    url: string,
    init: RequestInit = {},
    opts: { operation?: string; timeoutMs?: number; allowNonIdempotentRetry?: boolean } = {},
  ): Promise<Response> {
    return this.external.fetchWithRetry(url, init, {
      service: 'opencode',
      operation: opts.operation ?? 'fetch',
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      allowNonIdempotentRetry: opts.allowNonIdempotentRetry,
    });
  }

  /**
   * Liveness probe for the opencode server (v2 `GET /api/info`).
   *
   * The 2.x spec has NO health path at all: `GET /api/health` answers 404,
   * while `/health` and `/global/health` return the SPA index (200
   * text/html) — a JSON liveness endpoint is the only honest signal, and
   * that is `/api/info` (`{version, pid, hostname, urls, paths,
   * capabilities}`; there is no `healthy` field to look for).
   *
   * `up` only when ALL hold: 2xx status AND `content-type: application/json`
   * AND the body parses as a JSON object. A 401 with a JSON body also means
   * `up` (the server is alive; the bearer token is missing/rejected — auth,
   * not liveness). HTML/non-JSON bodies (the SPA catch-all, proxies, stale
   * gateways) and network errors/timeouts mean `down`. Always resolves,
   * never throws; single attempt (no retry budget on the probe); never logs
   * secrets.
   */
  async checkConnectivity(timeoutMs = OPENCODE_HEALTH_TIMEOUT_MS): Promise<OpencodeStatus> {
    try {
      const res = await this.fetchWithTimeout(
        `${this.dialUrl()}/api/info`,
        { method: 'GET' },
        timeoutMs,
      );
      const contentType = res.headers.get('content-type') ?? '';
      const isJson = contentType.toLowerCase().includes('application/json');
      const body = await res.arrayBuffer().catch(() => null);
      if (!body) return 'down';
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(Buffer.from(body).toString('utf8'));
      } catch {
        return 'down';
      }
      if (parsed === null || typeof parsed !== 'object') return 'down';
      if (res.status === 401) return isJson ? 'up' : 'down';
      if (!res.ok || !isJson) return 'down';
      return 'up';
    } catch (err) {
      this.logger.debug(`[opencode] unreachable: ${(err as Error).message}`);
      return 'down';
    }
  }

  private createClient(userId: string, cid: string): Promise<OpencodeClient> {
    if (!this.sdkClient) throw new Error('OpencodeSdkClient is not wired');
    return this.sdkClient.create(userId, cid);
  }

  private projectDirectory(
    projectId: string | undefined,
    userId: string,
    cid: string,
  ): Promise<{ projectId: string; directory: string }> {
    if (!this.access) throw new Error('ProjectAccessService is not wired');
    return this.access.resolveProjectDirectory(projectId, userId, cid);
  }

  private isUpstreamOk<T>(data: T | undefined, error: unknown): data is T {
    return data !== undefined && error === undefined;
  }

  /**
   * Real upstream HTTP status carried by the sdk result tuple.
   *
   * The v2 sdk answers a non-2xx with `{ error, request, response }` — the
   * parsed upstream body lands in `error` (it has NO status field, e.g.
   * `{"_tag":"UnauthorizedError"}`), while the HTTP status lives on
   * `response.status`. Without this the upstream 401/403 was masked as
   * "service unavailable" (EXTERNAL_UNAVAILABLE).
   */
  private sdkStatus(result: { response?: { status?: number } }): number | undefined {
    const status = result.response?.status;
    return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
  }

  /**
   * Maps an upstream failure to a typed ExternalServiceError.
   *
   * `status` is the REAL upstream status when the caller has it (see
   * sdkStatus) — 401/403 then become EXTERNAL_UNAUTHORIZED instead of the
   * generic "service unavailable". Without a known status the error is
   * normalized by fromUnknown (network / timeout / unknown shape).
   */
  private upstreamError(operation: string, error: unknown, status?: number): Error {
    if (status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599) {
      return fromStatus('opencode', operation, status, 1, error);
    }
    return fromUnknown('opencode', operation, error ?? new Error('upstream_error'));
  }

  /**
   * Runs one upstream call and maps its failure to ExternalServiceError.
   *
   * Wraps every route's call site: the warn/debug lines stay the same
   * (`[opencode] <METHOD> upstream failed` + the message only, never URLs
   * or bodies), and the throw goes through upstreamError — an
   * ExternalServiceError raised inside `run` (e.g. the status-carrying
   * `upstreamError(op, res.error, sdkStatus(res))`) passes through
   * fromUnknown unchanged, so the real upstream status is not lost.
   */
  private async runUpstream<T>(
    operation: string,
    method: string,
    correlationId: string | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.logger.warn(`[opencode] ${method} upstream failed`, correlationId);
      this.logger.debug((error as Error).message, correlationId);
      throw this.upstreamError(operation, error);
    }
  }

  /**
   * Copy upstream cursor headers (x-next-cursor/Link, when present) onto
   * the downstream JSON response. The v2 client defaults to
   * `responseStyle: 'fields'`, so the raw fetch Response rides on the
   * result tuple (`response` field).
   */
  private passthroughCursors(
    sdkResult: { response?: { headers?: Headers } },
    res?: ExpressResponse,
  ): void {
    const headers = sdkResult.response?.headers;
    if (!headers || !res) return;
    for (const name of CURSOR_PASSTHROUGH_HEADERS) {
      const value = headers.get(name);
      if (value) res.setHeader(name, value);
    }
  }

  private parseLimit(limitRaw?: string): number | undefined {
    if (limitRaw === undefined) return undefined;
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new BadRequestException('Query "limit" must be a non-negative integer');
    }
    return limit;
  }

  /**
   * SSE re-stream — shared mechanics in common/sse/sse-relay.ts (extracted
   * unchanged; the domain /api/sessions/events route rides the same
   * transport). Prefix/`[opencode]` log lines and error mapping are
   * preserved 1:1 (opencode.e2e covers the down-probe 503 + headers).
   */
  private relaySse(
    operation: string,
    cid: string,
    req: ExpressRequest,
    res: ExpressResponse,
    subscribe: (signal: AbortSignal) => Promise<SseSubscription>,
  ): Promise<void> {
    return relaySse({
      operation,
      cid,
      req,
      res,
      subscribe,
      logger: this.logger,
      prefix: '[opencode]',
      probe: () => this.checkConnectivity(),
      unreachableError: () => this.upstreamError(operation, new Error('unreachable')),
      subscribeFailedError: (err) => this.upstreamError(operation, err),
    });
  }

  // --- sessions -----------------------------------------------------------

  async listSessions(
    projectId: string | undefined,
    userId: string,
    cid: string,
  ): Promise<Array<SessionV2Info>> {
    // C4: project gate first; the listing is scoped to the project jail
    // (client ?directory ignored — see resolveProjectDirectory).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('listSessions', 'GET /session', cid, async () => {
      // v2 namespace (GET /api/session): the v2 envelope is { data, cursor }
      // — unwrap .data so the route still answers an array (external
      // signature unchanged).
      const res = await client.v2.session.list({ directory: projectDir });
      if (this.isUpstreamOk(res.data, res.error)) return res.data.data;
      throw this.upstreamError('listSessions', res.error, this.sdkStatus(res));
    });
  }

  async createSession(
    projectId: string | undefined,
    userId: string,
    cid: string,
  ): Promise<Session> {
    // C4: project gate first. The gated jailed project dir becomes the
    // session LOCATION for the upstream create: v2 POST /api/session
    // requires a JSON object body — an empty body is rejected upstream
    // (400 `Expected object`) and additionally stripped by the pinned sdk
    // transport (stripEmptySlots), so a non-empty `location` is both the
    // correct scoping and the payload the request actually needs. No dir
    // from the gate → the gate error propagates (fail-closed: no cwd or
    // default path is ever sent as a location).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('createSession', 'POST /session', cid, async () => {
      // v2 namespace (POST /api/session): the legacy POST /session answers
      // 405, so create goes through `client.v2.session.create`. The body
      // carries only `location` — the v2 create accepts id/agent/model/
      // location and nothing else. The external signature keeps `_body`/
      // `?directory` for stability — neither is forwarded upstream (client
      // ?directory is ignored; the gate binds the jail). The envelope is
      // `{ data: SessionV2Info }` — unwrap .data and pass through minimally
      // (frontend navigates by .id; numeric `time` is Date-parseable).
      // TODO(card 4): title/parentID теряются @opencode-ai/sdk 1.18.33 —
      // v2 session.create sends only id/agent/model/location; forwarding
      // the rest needs a transport below the generated sdk.
      const res = await client.v2.session.create({
        location: { directory: projectDir },
      });
      if (this.isUpstreamOk(res.data, res.error)) {
        return res.data.data as unknown as Session;
      }
      throw this.upstreamError('createSession', res.error, this.sdkStatus(res));
    });
  }

  async sessionStatus(
    projectId: string | undefined,
    userId: string,
    cid: string,
  ): Promise<unknown> {
    // C4: project gate first; upstream status is scoped to the project jail
    // (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('sessionStatus', 'GET /session/status', cid, async () => {
      const res = await client.session.status({ directory: projectDir });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('sessionStatus', res.error, this.sdkStatus(res));
    });
  }

  async getSession(
    projectId: string | undefined,
    userId: string,
    id: string,
    cid: string,
  ): Promise<SessionV2Info> {
    // C4: project gate before the session :id (v2 get is path-only — the
    // gate is the binding; client ?directory ignored).
    await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('getSession', 'GET /session/:id', cid, async () => {
      // v2 namespace (GET /api/session/{sessionID}, path-only — ?directory
      // stays on the route for signature stability, v2 takes no query).
      // Envelope is { data } — unwrap (route still answers one object).
      const res = await client.v2.session.get({
        sessionID: id,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data.data;
      throw this.upstreamError('getSession', res.error, this.sdkStatus(res));
    });
  }

  async deleteSession(
    projectId: string | undefined,
    userId: string,
    id: string,
    cid: string,
  ): Promise<{ deleted: boolean }> {
    // C4: project gate before the session :id; upstream delete runs in the
    // project jail (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('deleteSession', 'DELETE /session/:id', cid, async () => {
      const res = await client.session.delete({
        sessionID: id,
        directory: projectDir,
      });
      if (res.error === undefined) return { deleted: true };
      throw this.upstreamError('deleteSession', res.error, this.sdkStatus(res));
    });
  }

  async updateSession(
    projectId: string | undefined,
    userId: string,
    id: string,
    body: OpencodeSessionUpdateInput,
    cid: string,
  ): Promise<Session> {
    // C4: project gate before the session :id; upstream update runs in the
    // project jail (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('updateSession', 'PATCH /session/:id', cid, async () => {
      const res = await client.session.update({
        sessionID: id,
        ...body,
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('updateSession', res.error, this.sdkStatus(res));
    });
  }

  async forkSession(
    projectId: string | undefined,
    userId: string,
    id: string,
    body: OpencodeForkInput,
    cid: string,
  ): Promise<Session> {
    // C4: project gate before the session :id; upstream fork runs in the
    // project jail (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('forkSession', 'POST /session/:id/fork', cid, async () => {
      const res = await client.session.fork({
        sessionID: id,
        ...body,
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('forkSession', res.error, this.sdkStatus(res));
    });
  }

  // --- messages -----------------------------------------------------------

  async listMessages(
    projectId: string | undefined,
    userId: string,
    id: string,
    query: { limit?: string; before?: string },
    res: ExpressResponse | undefined,
    cid: string,
  ): Promise<unknown> {
    // C4: project gate before the session :id (v2 messages take no
    // directory — the gate is the binding; client ?directory ignored).
    await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    // NOTE: this route keeps its own try/catch instead of runUpstream — the
    // in-try ?limit validation (parseLimit) throws BadRequestException and
    // MUST stay a 400 bad_request, not be normalized to EXTERNAL_UNAVAILABLE;
    // runUpstream's upstreamError path has no Nest-exception passthrough.
    try {
      const limit = this.parseLimit(query.limit);
      // v2 namespace (GET /api/session/{sessionID}/message): limit maps 1:1;
      // legacy `before` (message id) has no v2 counterpart — forwarded
      // best-effort as the opaque `cursor` (upstream 400 → our 503);
      // ?directory stays on the route, v2 takes no directory query.
      // Envelope is { data, cursor } — return the array (route shape
      // unchanged); cursor-header passthrough below is a no-op for v2.
      const sdkRes = await client.v2.session.messages({
        sessionID: id,
        ...(limit !== undefined ? { limit } : {}),
        ...(query.before ? { cursor: query.before } : {}),
      });
      if (this.isUpstreamOk(sdkRes.data, sdkRes.error)) {
        this.passthroughCursors(sdkRes, res);
        return sdkRes.data.data;
      }
      throw this.upstreamError('listMessages', sdkRes.error, this.sdkStatus(sdkRes));
    } catch (err) {
      this.logger.warn('[opencode] GET /session/:id/message upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw err instanceof BadRequestException
        ? err
        : this.upstreamError('listMessages', err);
    }
  }

  async getMessage(
    projectId: string | undefined,
    userId: string,
    id: string,
    messageID: string,
    cid: string,
  ): Promise<unknown> {
    // C4: project gate before the session :id (v2 message is path-only —
    // the gate is the binding; client ?directory ignored).
    await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('getMessage', 'GET /session/:id/message/:messageID', cid, async () => {
      // v2 namespace (GET /api/session/{sessionID}/message/{messageID},
      // path-only — ?directory stays on the route, v2 takes no query).
      // Envelope is { data } — unwrap (route still answers one object).
      const res = await client.v2.session.message({
        sessionID: id,
        messageID,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data.data;
      throw this.upstreamError('getMessage', res.error, this.sdkStatus(res));
    });
  }

  async prompt(
    projectId: string | undefined,
    userId: string,
    id: string,
    body: OpencodePromptInput,
    cid: string,
  ): Promise<unknown> {
    // C4: project gate before the session :id; the prompt runs in the
    // project jail (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('prompt', 'POST /session/:id/message', cid, async () => {
      // zod keeps `format` as unknown (upstream OutputFormat passthrough) —
      // narrow it at the boundary so the flat v2 params stay typed.
      const { format, ...rest } = body;
      const res = await client.session.prompt({
        sessionID: id,
        ...rest,
        ...(format === undefined ? {} : { format: format as OutputFormat }),
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('prompt', res.error, this.sdkStatus(res));
    });
  }

  async promptAsync(
    projectId: string | undefined,
    userId: string,
    id: string,
    body: OpencodePromptInput,
    cid: string,
  ): Promise<void> {
    // C4: project gate before the session :id; the prompt runs in the
    // project jail (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('promptAsync', 'POST /session/:id/prompt_async', cid, async () => {
      const { format, ...rest } = body;
      const res = await client.session.promptAsync({
        sessionID: id,
        ...rest,
        ...(format === undefined ? {} : { format: format as OutputFormat }),
        directory: projectDir,
      });
      if (res.error !== undefined) {
        throw this.upstreamError('promptAsync', res.error, this.sdkStatus(res));
      }
    });
  }

  async runCommand(
    projectId: string | undefined,
    userId: string,
    id: string,
    body: OpencodeCommandInput,
    cid: string,
  ): Promise<unknown> {
    // C4: project gate before the session :id; the command runs in the
    // project jail (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('runCommand', 'POST /session/:id/command', cid, async () => {
      const res = await client.session.command({
        sessionID: id,
        ...body,
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('runCommand', res.error, this.sdkStatus(res));
    });
  }

  async runShell(
    projectId: string | undefined,
    userId: string,
    id: string,
    body: OpencodeShellInput,
    cid: string,
  ): Promise<unknown> {
    // C4: project gate before the session :id; the shell runs in the
    // project jail (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('runShell', 'POST /session/:id/shell', cid, async () => {
      const res = await client.session.shell({
        sessionID: id,
        ...body,
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('runShell', res.error, this.sdkStatus(res));
    });
  }

  async abortSession(
    projectId: string | undefined,
    userId: string,
    id: string,
    cid: string,
  ): Promise<unknown> {
    // C4: project gate before the session :id; upstream abort runs in the
    // project jail (client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('abortSession', 'POST /session/:id/abort', cid, async () => {
      const res = await client.session.abort({
        sessionID: id,
        directory: projectDir,
      });
      if (res.error === undefined) return res.data ?? { aborted: true };
      throw this.upstreamError('abortSession', res.error, this.sdkStatus(res));
    });
  }

  // --- providers ----------------------------------------------------------

  async listProviders(
    projectId: string | undefined,
    userId: string,
    cid: string,
  ): Promise<unknown> {
    // C4: project gate (the provider list takes a location directory — it
    // always uses the project jail; client ?directory ignored).
    const { directory: projectDir } = await this.projectDirectory(projectId, userId, cid);
    const client = await this.createClient(userId, cid);
    return this.runUpstream('listProviders', 'GET /config/providers', cid, async () => {
      // v2 namespace (GET /api/provider): legacy ?directory maps to the v2
      // `location` object; the v2 envelope ({ location, data }) is returned
      // as-is (route type is unknown — external signature unchanged).
      const res = await client.v2.provider.list({
        location: { directory: projectDir },
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('listProviders', res.error, this.sdkStatus(res));
    });
  }

  // --- events (SSE re-stream) ---------------------------------------------

  async streamEvents(
    userId: string,
    req: ExpressRequest,
    res: ExpressResponse,
    cid: string,
  ): Promise<void> {
    // 401 unauthorized (mock identity) resolves here (before relaySse),
    // so a mock caller answers 401 instead of being mapped to 503 inside
    // relaySse.
    const client = await this.createClient(userId, cid);
    await this.relaySse('GET /global/event', cid, req, res, (signal) =>
      Promise.resolve(
        client.global.event({
          signal,
          sseDefaultRetryDelay: 500,
          sseMaxRetryDelay: 2000,
        }) as unknown as Promise<SseSubscription>,
      ),
    );
  }

  async streamLegacyEvents(
    userId: string,
    req: ExpressRequest,
    res: ExpressResponse,
    cid: string,
  ): Promise<void> {
    // 401 unauthorized (mock identity) resolves here (before relaySse),
    // so a mock caller answers 401 instead of being mapped to 503 inside
    // relaySse.
    const client = await this.createClient(userId, cid);
    await this.relaySse('GET /event', cid, req, res, (signal) =>
      Promise.resolve(
        // v2 namespace (GET /api/event SSE): takes no params — ?directory
        // stays on the route for signature stability, not forwarded.
        client.v2.event.subscribe({
          signal,
          sseDefaultRetryDelay: 500,
          sseMaxRetryDelay: 2000,
        }) as unknown as Promise<SseSubscription>,
      ),
    );
  }

  // --- health -------------------------------------------------------------

  async globalHealth(cid: string): Promise<{ healthy: boolean; version: string }> {
    // The pinned sdk exposes no global.health (only global.event), so this
    // one goes through OpencodeService.fetchWithRetry directly (same
    // REQUEST_TIMEOUT_MS budget + idempotent retry as the sdk transport).
    //
    // CONTRACT CHANGE (forward-only): the 2.x upstream has NO /global/health
    // — the old passthrough always hit the SPA index (200 text/html) and the
    // shape check failed deterministically. The route now probes the real
    // liveness endpoint GET /api/info ({version, pid, hostname, …} — there
    // is no `healthy` field upstream) and SYNTHESIZES the public payload:
    // `healthy: true` iff /api/info answered 2xx JSON with a string
    // `version`; the wire shape ({healthy, version}) is unchanged so the
    // mobile ConnectionBadge/`client.global.health()` keep working (their
    // fail-closed shape check is exactly `healthy===true && version:
    // string`). A 2xx that is not that JSON (SPA catch-all, proxy page) is
    // NOT healthy — it stays a 503 shape failure, never a masked 200.
    //
    // The browser-side route is anonymous (no JwtAuthGuard) — that does NOT
    // make the upstream probe anonymous: the live 2.x stand requires Basic
    // auth on /api/info (unset password → no header, upstream 401 stays the
    // honest signal). Same pattern as every other serve call
    // (sessions.service, OpencodeSdkClient.create).
    return this.runUpstream('globalHealth', 'GET /global/health', cid, async () => {
      const res = await this.fetchWithRetry(
        `${this.dialUrl()}/api/info`,
        { method: 'GET', headers: { ...serveBasicAuthHeader() } },
        { operation: 'globalHealth' },
      );
      // The upstream answered non-2xx — the real status is known here (a raw
      // fetch Response), so 401/403 become EXTERNAL_UNAUTHORIZED instead of
      // the masked "service unavailable".
      if (!res.ok) {
        throw this.upstreamError('globalHealth', new Error(`status_${res.status}`), res.status);
      }
      const body = (await res.json().catch(() => null)) as unknown;
      if (typeof body !== 'object' || body === null) {
        throw this.upstreamError('globalHealth', new Error('bad_health_shape'));
      }
      const version = (body as { version?: unknown }).version;
      if (typeof version !== 'string') {
        throw this.upstreamError('globalHealth', new Error('bad_health_shape'));
      }
      return { healthy: true, version };
    });
  }
}
