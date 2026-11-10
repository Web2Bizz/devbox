import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { JwtAuthGuard } from '../../../../../auth/jwt-auth.guard';
import type { RequestIdentity } from '../../../../../auth/identity.service';
import { ReqUser } from '../../../../../auth/req-user.decorator';
import { AppLogger } from '@common/logger';
import { ZodValidationPipe } from '@common/validation';
import { ApiErrorDto } from '@common/http/api/api.dto';
import {
  createSessionRequestSchema,
  interruptSessionRequestSchema,
  revertStageRequestSchema,
  sendMessageRequestSchema,
  sessionForkRequestSchema,
  type CreateSessionInput,
  type InterruptSessionInput,
  type RevertInfo,
  type RevertStageRequest,
  type SendMessageInput,
  type SessionForkRequest,
  type SessionForkResponse,
  type SessionInfo,
  type SessionInterruptResult,
  type SessionMessage,
  type SessionModel,
  type SessionRunStatusMap,
  type SessionRunnerProvider,
  type SnapshotDiff,
} from './sessions.dto';
import { SessionsService } from './sessions.service';

/**
 * Domain session routes — /api/v1/sessions* (URI-versioned v1 under the
 * global 'api' prefix, NOT VERSION_NEUTRAL). This is the product-facing
 * contract that replaces the removed /api/opencode/* mirror: our names, our
 * shapes, no opencode vocabulary on the wire (SessionsService orchestrates the
 * domain zones and keeps the wire contract frozen).
 *
 * Auth: every route is JwtAuthGuard + the C4 project gate (projectId
 * required; strangers → 404 not_found with no existence leak). Guests →
 * 401 before any gate/upstream work.
 *
 * Errors follow the shared mapping (external-error): request-level 4xx are
 * honest and non-retryable (no Retry-After), only real outages answer
 * 503 EXTERNAL_UNAVAILABLE + Retry-After.
 */
@ApiTags('sessions')
@ApiBearerAuth()
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly logger: AppLogger = new AppLogger(SessionsController.name),
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: 'List project sessions (domain shape; runtime status derived from the live session runner)' })
  @ApiResponse({ status: 200, description: 'domain sessions (always an array; empty when the project has none)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or the session runner rejected the request (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async list(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationIdHeader?: string,
  ): Promise<Array<SessionInfo>> {
    const correlationId: string = correlationIdHeader ?? '';
    const rows: Array<SessionInfo> = await this.sessions.list(identity.id, projectId, correlationId);
    this.logger.info(`[sessions] list count=${rows.length}`, correlationId);
    return rows;
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a project session (domain shape; title/parentID forwarded honestly)' })
  @ApiResponse({ status: 200, description: 'created domain session' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate), invalid body (bad_request — our zod) or the session runner rejected the payload (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async create(
    @ReqUser() identity: RequestIdentity,
    @Body(new ZodValidationPipe(createSessionRequestSchema)) body: CreateSessionInput,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionInfo> {
    return this.sessions.create(identity.id, body, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Get('status')
  @ApiOperation({ summary: 'Runtime status map for project sessions (sessionId → busy/idle snapshot; retry lives on the event stream)' })
  @ApiResponse({ status: 200, description: 'sessionId → status map (derived from the live runner state; not a cached/empty source)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or the session runner rejected the request (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async status(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionRunStatusMap> {
    return this.sessions.statusMap(identity.id, projectId, correlationId ?? '');
  }

  // Literal one-segment routes (status/providers) are declared before the
  // ':id/...' two-segment routes; keep that ordering when adding more.
  @UseGuards(JwtAuthGuard)
  @Get('providers')
  @ApiOperation({ summary: 'List the project session-runner providers (required artifact subset; credential-bearing members are never projected)' })
  @ApiResponse({ status: 200, description: 'domain provider rows (always an array; empty when the runner reports none)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or the session runner rejected the request (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or the location is unknown upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async providers(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Array<SessionRunnerProvider>> {
    return this.sessions.providers(identity.id, projectId, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Get('models')
  @ApiOperation({ summary: 'List runner models filtered to the OpenCode Go/Zen family' })
  @ApiResponse({ status: 200, description: 'domain model rows' })
  async models(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Array<SessionModel>> {
    return this.sessions.models(identity.id, projectId, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/messages')
  @ApiOperation({ summary: 'List session messages (normalized domain rows; text projection of the runtime message union)' })
  @ApiResponse({ status: 200, description: 'normalized messages (always an array; empty when the session has none)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate), invalid query (bad_request — our limit validation) or the session runner rejected the request shape (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or session/message absent upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async messages(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Array<SessionMessage>> {
    return this.sessions.listMessages(identity.id, id, projectId, limit, cursor, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a session message (queues the prompt on the session runner; the reply streams over events)' })
  @ApiResponse({ status: 200, description: 'queued user message receipt (domain row)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate), invalid body (bad_request — our zod) or the session runner rejected the payload shape (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or session absent upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After), it refused our credentials (EXTERNAL_UNAUTHORIZED) or the session is busy (upstream 409 surfaces as a 503 with Retry-After)', type: ApiErrorDto })
  async sendMessage(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(sendMessageRequestSchema)) body: SendMessageInput,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionMessage> {
    return this.sessions.sendMessage(identity.id, id, body, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/interrupt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Interrupt the active session execution (idle interruption is an honest no-op: interrupted=false)' })
  @ApiResponse({ status: 200, description: 'interrupted: whether an active execution was really interrupted (false = idle no-op, never an error)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate), invalid body (bad_request — our zod) or the session runner rejected the request shape (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or session absent upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async interrupt(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(interruptSessionRequestSchema)) body: InterruptSessionInput,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionInterruptResult> {
    return this.sessions.interrupt(identity.id, id, body, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/fork')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fork a session at a message boundary (copy of the durable thread up to it)' })
  @ApiResponse({ status: 200, description: "created session plus the boundary copied ('before' excludes the message, 'through' includes it)" })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or invalid body (bad_request — our zod) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found) or the boundary message is absent (MessageNotFound) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 409, description: 'the thread has no messages to fork (ForkEmpty) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner or durable store unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async fork(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(sessionForkRequestSchema)) body: SessionForkRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionForkResponse> {
    return this.sessions.fork(identity.id, id, body, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/revert/stage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stage a revert of the files touched after a message boundary (snapshot restore + diff)' })
  @ApiResponse({ status: 200, description: 'staged revert state (boundary, source snapshot or null, produced file diffs)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED) or invalid body (bad_request) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found) or the boundary message is absent (MessageNotFound) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'snapshots unavailable (EXTERNAL_UNAVAILABLE, Retry-After) or the durable store is unreachable', type: ApiErrorDto })
  async stageRevert(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(revertStageRequestSchema)) body: RevertStageRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RevertInfo> {
    return this.sessions.stageRevert(identity.id, id, body, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/revert')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Discard the staged revert (restore the files to their pre-stage state)' })
  @ApiResponse({ status: 204, description: 'staged revert cleared, files restored to their pre-stage state' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'snapshot restore unavailable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async clearRevert(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    await this.sessions.clearRevert(identity.id, id, projectId, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/revert/commit')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Commit the staged revert (keep the restored files, drop the staged state)' })
  @ApiResponse({ status: 204, description: 'staged revert committed and cleared' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'durable store unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async commitRevert(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    await this.sessions.commitRevert(identity.id, id, projectId, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/snapshots/diff')
  @ApiOperation({ summary: 'Per-file diff between two session snapshots (git tree ids)' })
  @ApiResponse({ status: 200, description: 'per-file diff rows (empty when the trees are equal)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED), absent/invalid from/to or invalid context (bad_request) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'snapshots unavailable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async snapshotDiff(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('context') context?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Array<SnapshotDiff>> {
    return this.sessions.snapshotDiff(
      identity.id,
      id,
      projectId,
      from ?? '',
      to ?? '',
      context,
      correlationId ?? '',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('events')
  @ApiOperation({ summary: 'Live session events (SSE; domain frames {id, type, data, session?})' })
  @ApiResponse({ status: 200, description: 'text/event-stream of domain SessionStreamFrame rows' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async events(
    @ReqUser() identity: RequestIdentity,
    @Req() request: ExpressRequest,
    @Res({ passthrough: false }) response: ExpressResponse,
    @Query('projectId') projectId?: string,
    @Query('session') session?: string,
    @Query('cursor') cursor?: string,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<void> {
    // ?session=/?cursor=/Last-Event-ID ride the raw request into the stream
    // zone (query-parser already populated request.query/request.headers) —
    // referenced here so the params stay explicit in the signature and swagger.
    void session;
    void cursor;
    void lastEventId;
    await this.sessions.streamEvents(identity.id, projectId, correlationId ?? '', request, response);
  }
}
