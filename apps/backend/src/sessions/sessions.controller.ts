import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { RequestIdentity } from '../auth/identity.service';
import { ReqUser } from '../auth/req-user.decorator';
import { AppLogger } from '../common/app-logger.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApiErrorDto } from '../api/dto';
import {
  createSessionRequestSchema,
  type CreateSessionInput,
  type SessionInfo,
  type SessionRunStatusMap,
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
}
