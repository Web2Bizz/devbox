import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Req,
  UseGuards,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
// the same paths this controller mirrors under `/api/opencode/*`.
import type { OutputFormat, Session, SessionV2Info } from '@opencode-ai/sdk/v2';
import { OpencodeSdkClient } from './opencode-client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { RequestIdentity } from '../auth/identity.service';
import { ReqUser } from '../auth/req-user.decorator';
import { OrganizationsService } from '../organizations/organizations.service';
import { ownerKeyOrThrow } from '../projects/projects.service';
import { WorkspacePathService } from '../workspaces/workspace-path.service';
import { OpencodeService } from './opencode.service';
import { AppLogger } from '../common/app-logger.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  ApiErrorDto,
  opencodeCommandSchema,
  opencodeForkSchema,
  opencodePromptSchema,
  opencodeSessionUpdateSchema,
  opencodeShellSchema,
  type OpencodeCommandInput,
  type OpencodeForkInput,
  type OpencodePromptInput,
  type OpencodeSessionUpdateInput,
  type OpencodeShellInput,
} from '../api/dto';
import { fromStatus, fromUnknown } from '../common/external/external-error';
import { relaySse, type SseSubscription } from '../common/sse-relay';

/** Upstream cursor headers passed through on GET message lists (when present). */
const CURSOR_PASSTHROUGH_HEADERS = ['x-next-cursor', 'link'] as const;

/**
 * OpenCode reverse-proxy (sdk-driven).
 *
 * VERSION_NEUTRAL under the global 'api' prefix → routes are /api/opencode/*.
 * Paths mirror the upstream opencode OpenAPI 1:1 (/session, /session/status,
 * /session/{id}, /session/{id}/message, /session/{id}/message/{messageID},
 * /session/{id}/prompt_async, /session/{id}/command, /session/{id}/shell,
 * /session/{id}/fork, /config/providers, /global/event, /global/health,
 * /event, … — see contracts/opencode-upstream.json for the /doc snapshot)
 * so the frontend can use the SAME @opencode-ai/sdk against the backend
 * base URL (`<NEXT_PUBLIC_API_URL>/api/opencode`) with no new contracts
 * and no direct browser → opencode calls.
 *
 * Auth: every upstream route except GET global/health requires JwtAuthGuard
 * (@ReqUser() identity → real-user gate: non-uuid mock → 401
 * `unauthorized`); upstream auth is the server Basic password
 * (OPENCODE_PASSWORD, unset → no header, upstream 401). There is NO
 * per-user DB Bearer and NO env token fallback on this path. GET
 * global/health stays anonymous (liveness probe, no auth sent) and is
 * SYNTHESIZED from the v2 liveness endpoint GET /api/info — the 2.x
 * upstream spec has no /global/health (the path answers the SPA index).
 *
 * Project scope (Card C4): every session/message/provider route requires a
 * `?projectId` and gates through
 * OrganizationsService.assertProjectAccessById BEFORE any upstream call
 * (org-linked → member, user-space → owner; strangers → 404, no existence
 * leak; missing projectId → 400 PROJECT_REQUIRED). The caller's `?directory`
 * is accepted for compatibility but IGNORED — upstream calls that take a
 * directory always use the gated project's jailed content dir
 * (WorkspacePathService.resolveUserStrict + assertInsideJail; unconfigured
 * storage fails closed). v2 calls without a directory parameter ride the
 * gate only (documented per route). The SSE event streams (`global/event`,
 * `event`) and GET `global/health` stay project-free (global surfaces, no
 * session :id) — recorded remainder, not an exception for session reads.
 *
 * Serve auth is untouched: JwtAuthGuard + @ReqUser() + OpencodeAuthService
 * real-user gate + serveBasicAuthHeader (server Basic) behave exactly as
 * before — only auth=yes|no presence is traced, never secrets.
 *
 * Behavior mirrors ProxyService: upstream failures (even after the
 * ExternalClient retry budget inside OpencodeSdkClient) throw
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
 */
@ApiTags('opencode')
@ApiBearerAuth()
@Controller('opencode')
export class OpencodeController {
  constructor(
    private readonly sdk: OpencodeSdkClient,
    private readonly opencode: OpencodeService,
    private readonly orgs: OrganizationsService,
    private readonly paths: WorkspacePathService,
    private readonly logger: AppLogger = new AppLogger('OpencodeController'),
  ) {}

  /**
   * C4 project gate + directory jail (reuse, not a new rule).
   *
   * - Missing projectId → 400 PROJECT_REQUIRED (fail-closed: session routes
   *   are project-scoped, there is no cross-project listing anymore).
   * - assertProjectAccessById → 404 for strangers (no existence leak).
   * - Returns the gated project's jailed content dir; callers pass it as
   *   the upstream directory INSTEAD of the client `?directory` (which is
   *   ignored — a forged directory can never escape the project jail).
   * - Unconfigured storage fails closed (500 before any upstream call).
   */
  private async requireProjectDir(
    projectId: string | undefined,
    userId: string,
    correlationId?: string,
  ): Promise<string> {
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
    // Ownerless rows are denied by the gate (C5 deny-by-default), so the
    // owner is always a real uuid here; ownerKeyOrThrow reuses the
    // ProjectsService user-home mapping (no new layout).
    const resolved = await this.paths.resolveUserStrict(
      ownerKeyOrThrow(ownerId),
      projectId,
    );
    await this.paths.assertInsideJail(
      resolved.absRepo,
      await this.paths.realStrictRoot(),
    );
    return resolved.absRepo;
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
   * SSE re-stream — shared mechanics in common/sse-relay.ts (extracted
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
      probe: () => this.opencode.checkConnectivity(),
      unreachableError: () => this.upstreamError(operation, new Error('unreachable')),
      subscribeFailedError: (err) => this.upstreamError(operation, err),
    });
  }

  // --- sessions -----------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @Get('session')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List sessions (sdk → opencode server; outages 503, upstream/gate request errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live sessions' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or upstream rejected the request shape (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async listSessions(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionV2Info[]> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate first; the listing is scoped to the project jail
    // (client ?directory ignored — see requireProjectDir).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      // v2 namespace (GET /api/session): the v2 envelope is { data, cursor }
      // — unwrap .data so the route still answers an array (external
      // signature unchanged).
      const res = await client.v2.session.list({ directory: projectDir });
      if (this.isUpstreamOk(res.data, res.error)) return res.data.data;
      throw this.upstreamError('listSessions', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] GET /session upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('listSessions', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('session')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create session (sdk → opencode server; outages 503, upstream/gate request errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live session' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or upstream rejected the request shape (EXTERNAL_BAD_REQUEST — e.g. payload the v2 create refuses) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async createSession(
    @ReqUser() identity: RequestIdentity,
    @Body() _body: { title?: string; parentID?: string } = {},
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Session> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate first. The gated jailed project dir becomes the
    // session LOCATION for the upstream create: v2 POST /api/session
    // requires a JSON object body — an empty body is rejected upstream
    // (400 `Expected object`) and additionally stripped by the pinned sdk
    // transport (stripEmptySlots), so a non-empty `location` is both the
    // correct scoping and the payload the request actually needs. No dir
    // from the gate → the gate error propagates (fail-closed: no cwd or
    // default path is ever sent as a location).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
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
    } catch (err) {
      this.logger.warn('[opencode] POST /session upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('createSession', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('session/status')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Get session status (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live session status map' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async sessionStatus(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate first; upstream status is scoped to the project jail
    // (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.session.status({ directory: projectDir });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('sessionStatus', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] GET /session/status upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('sessionStatus', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('session/:id')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Get session (sdk → opencode server; outages 503, upstream/gate request errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live session' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or upstream rejected the request shape (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or session absent upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async getSession(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionV2Info> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id (v2 get is path-only — the
    // gate is the binding; client ?directory ignored).
    await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      // v2 namespace (GET /api/session/{sessionID}, path-only — ?directory
      // stays on the route for signature stability, v2 takes no query).
      // Envelope is { data } — unwrap (route still answers one object).
      const res = await client.v2.session.get({
        sessionID: id,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data.data;
      throw this.upstreamError('getSession', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] GET /session/:id upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('getSession', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Delete('session/:id')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Delete session (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'deleted flag (live upstream only)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async deleteSession(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<{ deleted: boolean }> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id; upstream delete runs in the
    // project jail (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.session.delete({
        sessionID: id,
        directory: projectDir,
      });
      if (res.error === undefined) return { deleted: true };
      throw this.upstreamError('deleteSession', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] DELETE /session/:id upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('deleteSession', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Patch('session/:id')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Update session (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live session' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or invalid body (bad_request — our zod) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async updateSession(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodeSessionUpdateSchema))
    body: OpencodeSessionUpdateInput,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Session> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id; upstream update runs in the
    // project jail (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.session.update({
        sessionID: id,
        ...body,
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('updateSession', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] PATCH /session/:id upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('updateSession', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('session/:id/fork')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fork session (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live forked session' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or invalid body (bad_request — our zod) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async forkSession(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodeForkSchema))
    body: OpencodeForkInput = {},
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Session> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id; upstream fork runs in the
    // project jail (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.session.fork({
        sessionID: id,
        ...body,
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('forkSession', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/fork upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('forkSession', err);
    }
  }

  // --- messages -----------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @Get('session/:id/message')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List session messages (sdk → opencode server; outages 503, upstream/gate request errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live messages' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate), invalid query (bad_request — our limit validation) or upstream rejected the request shape (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or session absent upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async listMessages(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Query('limit') limitRaw?: string,
    @Query('before') before?: string,
    @Res({ passthrough: true }) res?: ExpressResponse,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id (v2 messages take no
    // directory — the gate is the binding; client ?directory ignored).
    await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const limit = this.parseLimit(limitRaw);
      // v2 namespace (GET /api/session/{sessionID}/message): limit maps 1:1;
      // legacy `before` (message id) has no v2 counterpart — forwarded
      // best-effort as the opaque `cursor` (upstream 400 → our 503);
      // ?directory stays on the route, v2 takes no directory query.
      // Envelope is { data, cursor } — return the array (route shape
      // unchanged); cursor-header passthrough below is a no-op for v2.
      const sdkRes = await client.v2.session.messages({
        sessionID: id,
        ...(limit !== undefined ? { limit } : {}),
        ...(before ? { cursor: before } : {}),
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

  @UseGuards(JwtAuthGuard)
  @Get('session/:id/message/:messageID')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Get session message (sdk → opencode server; outages 503, upstream/gate request errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live message' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or upstream rejected the request shape (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or session/message absent upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async getMessage(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Param('messageID') messageID: string,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id (v2 message is path-only —
    // the gate is the binding; client ?directory ignored).
    await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      // v2 namespace (GET /api/session/{sessionID}/message/{messageID},
      // path-only — ?directory stays on the route, v2 takes no query).
      // Envelope is { data } — unwrap (route still answers one object).
      const res = await client.v2.session.message({
        sessionID: id,
        messageID,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data.data;
      throw this.upstreamError('getMessage', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] GET /session/:id/message/:messageID upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('getMessage', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('session/:id/message')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send session message (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live assistant reply' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or invalid body (bad_request — our zod) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async prompt(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodePromptSchema))
    body: OpencodePromptInput,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id; the prompt runs in the
    // project jail (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
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
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/message upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('prompt', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('session/:id/prompt_async')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Send async session message, return immediately (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 204, description: 'prompt accepted (live upstream only)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or invalid body (bad_request — our zod) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async promptAsync(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodePromptSchema))
    body: OpencodePromptInput,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id; the prompt runs in the
    // project jail (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
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
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/prompt_async upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('promptAsync', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('session/:id/command')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send command to session (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live assistant reply' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or invalid body (bad_request — our zod) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async runCommand(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodeCommandSchema))
    body: OpencodeCommandInput,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id; the command runs in the
    // project jail (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.session.command({
        sessionID: id,
        ...body,
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('runCommand', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/command upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('runCommand', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('session/:id/shell')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run shell command in session (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live created message' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or invalid body (bad_request — our zod) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async runShell(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodeShellSchema))
    body: OpencodeShellInput,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id; the shell runs in the
    // project jail (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.session.shell({
        sessionID: id,
        ...body,
        directory: projectDir,
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('runShell', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/shell upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('runShell', err);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('session/:id/abort')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abort session (sdk → opencode server; outages 503, gate/validation errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'abort result (live upstream only)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async abortSession(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate before the session :id; upstream abort runs in the
    // project jail (client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      const res = await client.session.abort({
        sessionID: id,
        directory: projectDir,
      });
      if (res.error === undefined) return res.data ?? { aborted: true };
      throw this.upstreamError('abortSession', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/abort upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('abortSession', err);
    }
  }

  // --- providers ----------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @Get('config/providers')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List providers (sdk → opencode server; outages 503, upstream/gate request errors answer honest 4xx)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live providers' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or upstream rejected the request shape (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or the location is unknown upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async listProviders(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Query('directory') _directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // C4: project gate (the provider list takes a location directory — it
    // always uses the project jail; client ?directory ignored).
    const projectDir = await this.requireProjectDir(projectId, userId, cid);
    const client = await this.sdk.create(userId, cid);
    try {
      // v2 namespace (GET /api/provider): legacy ?directory maps to the v2
      // `location` object; the v2 envelope ({ location, data }) is returned
      // as-is (route type is unknown — external signature unchanged).
      const res = await client.v2.provider.list({
        location: { directory: projectDir },
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('listProviders', res.error, this.sdkStatus(res));
    } catch (err) {
      this.logger.warn('[opencode] GET /config/providers upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('listProviders', err);
    }
  }

  // --- events (SSE re-stream) ---------------------------------------------

  @UseGuards(JwtAuthGuard)
  @Get('global/event')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Subscribe to legacy global events (SSE re-stream of GlobalEvent frames, 503 when unreachable)', deprecated: true })
  @ApiResponse({ status: 200, description: 'text/event-stream of upstream GlobalEvent frames ({directory, payload} wrapper; live only)' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async streamEvents(
    @ReqUser() identity: RequestIdentity,
    @Req() req: ExpressRequest,
    @Res() res: ExpressResponse,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // 401 unauthorized (mock identity) resolves here (before relaySse),
    // so a mock caller answers 401 instead of being mapped to 503 inside
    // relaySse.
    const client = await this.sdk.create(userId, cid);
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

  @UseGuards(JwtAuthGuard)
  @Get('event')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Subscribe to opencode v2 events (SSE re-stream of flat event frames, 503 when unreachable)', deprecated: true })
  @ApiResponse({ status: 200, description: 'text/event-stream of flat v2 bus event frames (OpencodeEvent; the sdk-parsed envelope is relayed verbatim)' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async streamLegacyEvents(
    @ReqUser() identity: RequestIdentity,
    @Req() req: ExpressRequest,
    @Res() res: ExpressResponse,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    const cid = correlationId ?? '';
    const userId = identity.id;
    // 401 unauthorized (mock identity) resolves here (before relaySse),
    // so a mock caller answers 401 instead of being mapped to 503 inside
    // relaySse.
    const client = await this.sdk.create(userId, cid);
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

  @Get('global/health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Opencode server liveness (synthesized from v2 GET /api/info, 503 when unreachable)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live upstream ({healthy: true, version}) — healthy is synthesized from a 2xx JSON /api/info answer (the 2.x upstream spec has no /global/health: it answers the SPA index)' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async globalHealth(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<{ healthy: boolean; version: string }> {
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
    const cid = correlationId ?? '';
    try {
      const res = await this.opencode.fetchWithRetry(
        `${this.opencode.dialUrl()}/api/info`,
        { method: 'GET' },
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
    } catch (err) {
      this.logger.warn('[opencode] GET /global/health upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('globalHealth', err);
    }
  }
}
