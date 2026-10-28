import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
  UsePipes,
  Version,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProxyService } from './proxy.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { RequestIdentity } from '../auth/identity.service';
import { ReqUser } from '../auth/req-user.decorator';
import { OrganizationsService } from '../organizations/organizations.service';
import { ownerKeyOrThrow } from '../projects/projects.service';
import { WorkspacePathService } from '../workspaces/workspace-path.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  ApiErrorDto,
  MessagesResponseDto,
  SendChatRequestDto,
  SendChatResponseDto,
  SessionDto,
  sendChatSchema,
} from './dto';
import {
  DEFAULT_API_VERSION,
  V1Endpoint,
} from './version';

/**
 * Proxy endpoints.
 *
 * Path segments come from the global 'api' prefix + URI versioning
 * (see configureApp in app.setup.ts) — the controller itself declares NO
 * 'api' segment, otherwise routes would stack into /api/api/*.
 *
 * - canonical:  GET/POST /api/v1/session|sessions|messages|chat  (@Version('1'))
 * - removed:    unversioned /api/* aliases → 404 { code: 'not_found', … }
 * - reserved:   /api/v2/* → 404 { code: 'not_found', … } (no v2 handlers)
 *
 * All routes require JwtAuthGuard: the caller's userId (@ReqUser()) passes
 * the real-user gate (non-uuid mock → 401 `unauthorized`); upstream auth is
 * the server Basic password (OPENCODE_PASSWORD, unset → no header, upstream
 * 401). No per-user DB Bearer on this path.
 *
 * Project scope (Card C4): every route requires `?projectId` and gates
 * through OrganizationsService.assertProjectAccessById BEFORE any upstream
 * call (missing → 400 PROJECT_REQUIRED; strangers → 404, no existence
 * leak). GET session additionally scopes the upstream list to the gated
 * project's jailed content dir; messages/chat ride the gate (their upstream
 * v2 paths take no directory filter — recorded remainder, same as the
 * OpencodeController v2 routes). Serve auth is untouched.
 */
@ApiTags('proxy')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ApiController {
  constructor(
    private readonly proxy: ProxyService,
    private readonly orgs: OrganizationsService,
    private readonly paths: WorkspacePathService,
  ) {}

  /**
   * C4 project gate + directory jail (reuse of the Card 5 access layer +
   * the ProjectsService user-home mapping — same helper shape as
   * OpencodeController.requireProjectDir).
   */
  private async requireProjectDir(
    projectId: string | undefined,
    userId: string,
    correlationId?: string,
  ): Promise<string> {
    if (!projectId || projectId.trim() === '') {
      throw new BadRequestException({
        code: 'PROJECT_REQUIRED',
        message: 'projectId is required — proxy routes are project-scoped',
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
    return resolved.absRepo;
  }

  // --- v1 (canonical) -------------------------------------------------------

  @Get('session')
  @Version(DEFAULT_API_VERSION)
  @V1Endpoint('Active session (proxy → opencode server, 503 when unreachable)')
  @ApiResponse({ status: 200, description: 'live session', type: SessionDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async getSessionV1(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionDto> {
    const projectDir = await this.requireProjectDir(projectId, identity.id, correlationId);
    return this.proxy.getSession(identity.id, correlationId ?? '', projectDir);
  }

  @Get('sessions')
  @Version(DEFAULT_API_VERSION)
  @V1Endpoint('Session list (proxy → opencode server, 503 when unreachable)')
  @ApiQuery({ name: 'projectId', required: true, type: String })
  @ApiResponse({ status: 200, description: 'live sessions', type: [SessionDto] })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async listSessionsV1(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SessionDto[]> {
    const projectDir = await this.requireProjectDir(projectId, identity.id, correlationId);
    return this.proxy.listSessions(identity.id, correlationId ?? '', projectDir);
  }

  @Get('messages')
  @Version(DEFAULT_API_VERSION)
  @V1Endpoint('Session messages (proxy → opencode server, 503 when unreachable)')
  @ApiQuery({ name: 'sessionId', required: false, type: String })
  @ApiQuery({ name: 'projectId', required: true, type: String })
  @ApiResponse({ status: 200, description: 'live messages', type: MessagesResponseDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async getMessagesV1(
    @ReqUser() identity: RequestIdentity,
    @Query('sessionId') sessionId?: string,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<MessagesResponseDto> {
    await this.requireProjectDir(projectId, identity.id, correlationId);
    return this.proxy.getMessages(identity.id, sessionId ?? '', correlationId ?? '');
  }

  @Post('chat')
  @Version(DEFAULT_API_VERSION)
  @V1Endpoint('Send chat message (proxy → opencode server, 503 when unreachable)')
  @HttpCode(HttpStatus.OK) // contract promises 200 (not Nest's POST-default 201)
  @ApiBody({ type: SendChatRequestDto })
  @ApiQuery({ name: 'projectId', required: true, type: String })
  @ApiResponse({ status: 200, description: 'live assistant reply', type: SendChatResponseDto })
  @ApiResponse({ status: 400, description: 'bad request', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  @UsePipes(new ZodValidationPipe(sendChatSchema))
  async sendChatV1(
    @ReqUser() identity: RequestIdentity,
    @Body() body: SendChatRequestDto,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SendChatResponseDto> {
    await this.requireProjectDir(projectId, identity.id, correlationId);
    return this.proxy.sendChat(identity.id, body.sessionId, body.message, correlationId ?? '');
  }
}
