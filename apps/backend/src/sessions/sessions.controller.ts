import {
  Body,
  Controller,
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
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { RequestIdentity } from '../auth/identity.service';
import { ReqUser } from '../auth/req-user.decorator';
import { AppLogger } from '../common/app-logger.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApiErrorDto } from '../api/dto';
import {
  createSessionRequestSchema,
  interruptSessionRequestSchema,
  sendMessageRequestSchema,
  type CreateSessionInput,
  type InterruptSessionInput,
  type SendMessageInput,
  type SessionInfo,
  type SessionInterruptResult,
  type SessionMessage,
  type SessionRunStatusMap,
  type SessionRunnerProvider,
} from './sessions.dto';
import { SessionsService } from './sessions.service';

/**
 * Domain session routes — /api/sessions* (VERSION_NEUTRAL under the global
 * 'api' prefix). This is the product-facing contract that replaces the
 * deprecated /api/opencode/* mirror: our names, our shapes, no opencode
 * vocabulary on the wire (SessionsService owns the translation).
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
    private readonly logger: AppLogger = new AppLogger('SessionsController'),
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List project sessions (domain shape; runtime status derived from the live session runner)' })
  @ApiResponse({ status: 200, description: 'domain sessions (always an array; empty when the project has none)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or the session runner rejected the request (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async list(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionInfo[]> {
    const cid = correlationId ?? '';
    const rows = await this.sessions.list(identity.id, projectId, cid);
    this.logger.info(`[sessions] list count=${rows.length}`, cid);
    return rows;
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @Version(VERSION_NEUTRAL)
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
  @Version(VERSION_NEUTRAL)
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
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List the project session-runner providers (required artifact subset; credential-bearing members are never projected)' })
  @ApiResponse({ status: 200, description: 'domain provider rows (always an array; empty when the runner reports none)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) or the session runner rejected the request (EXTERNAL_BAD_REQUEST) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) or the location is unknown upstream (EXTERNAL_NOT_FOUND) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async providers(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionRunnerProvider[]> {
    return this.sessions.providers(identity.id, projectId, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/messages')
  @Version(VERSION_NEUTRAL)
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
  ): Promise<SessionMessage[]> {
    return this.sessions.listMessages(identity.id, id, projectId, limit, cursor, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/messages')
  @Version(VERSION_NEUTRAL)
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
  @Version(VERSION_NEUTRAL)
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
  @Get('events')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Live session events (SSE; domain frames {id, type, data, session?})' })
  @ApiResponse({ status: 200, description: 'text/event-stream of domain SessionStreamFrame rows' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'session runner unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or it refused our credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async events(
    @ReqUser() identity: RequestIdentity,
    @Req() req: ExpressRequest,
    @Res({ passthrough: false }) res: ExpressResponse,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    await this.sessions.streamEvents(identity.id, projectId, correlationId ?? '', req, res);
  }
}
