import {
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
import type { Session, SessionV2Info } from '@opencode-ai/sdk/v2';
import { JwtAuthGuard } from '../../../../../auth/jwt-auth.guard';
import type { RequestIdentity } from '../../../../../auth/identity.service';
import { ReqUser } from '../../../../../auth/req-user.decorator';
import { OpencodeService } from './opencode.service';
import { ZodValidationPipe } from '../../../../../common/validation';
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
} from '../../../../../common/http/api/dto';

/**
 * OpenCode reverse-proxy (sdk-driven).
 *
 * VERSION_NEUTRAL under the global 'api' prefix → routes are /api/opencode/*.
 * Paths mirror the upstream opencode OpenAPI 1:1 (see
 * contracts/opencode-upstream.json for the /doc snapshot) so the frontend
 * can use the SAME @opencode-ai/sdk against the backend base URL
 * (`<NEXT_PUBLIC_API_URL>/api/opencode`) with no new contracts and no
 * direct browser → opencode calls.
 */
@ApiTags('opencode')
@ApiBearerAuth()
@Controller('opencode')
export class OpencodeController {
  constructor(private readonly opencode: OpencodeService) {}

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
  ): Promise<Array<SessionV2Info>> {
    return this.opencode.listSessions(projectId, identity.id, correlationId ?? '');
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
    return this.opencode.createSession(projectId, identity.id, correlationId ?? '');
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
    return this.opencode.sessionStatus(projectId, identity.id, correlationId ?? '');
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
    return this.opencode.getSession(projectId, identity.id, id, correlationId ?? '');
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
    return this.opencode.deleteSession(projectId, identity.id, id, correlationId ?? '');
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
    return this.opencode.updateSession(projectId, identity.id, id, body, correlationId ?? '');
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
    return this.opencode.forkSession(projectId, identity.id, id, body, correlationId ?? '');
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
    return this.opencode.listMessages(projectId, identity.id, id, { limit: limitRaw, before }, res, correlationId ?? '');
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
    return this.opencode.getMessage(projectId, identity.id, id, messageID, correlationId ?? '');
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
    return this.opencode.prompt(projectId, identity.id, id, body, correlationId ?? '');
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
    return this.opencode.promptAsync(projectId, identity.id, id, body, correlationId ?? '');
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
    return this.opencode.runCommand(projectId, identity.id, id, body, correlationId ?? '');
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
    return this.opencode.runShell(projectId, identity.id, id, body, correlationId ?? '');
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
    return this.opencode.abortSession(projectId, identity.id, id, correlationId ?? '');
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
    return this.opencode.listProviders(projectId, identity.id, correlationId ?? '');
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
    return this.opencode.streamEvents(identity.id, req, res, correlationId ?? '');
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
    return this.opencode.streamLegacyEvents(identity.id, req, res, correlationId ?? '');
  }

  // --- health -------------------------------------------------------------

  @Get('global/health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Opencode server liveness (synthesized from v2 GET /api/info with the server Basic credentials, 503 when unreachable)', deprecated: true })
  @ApiResponse({ status: 200, description: 'live upstream ({healthy: true, version}) — healthy is synthesized from a 2xx JSON /api/info answer (the 2.x upstream spec has no /global/health: it answers the SPA index)' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After) or upstream refused our server credentials (EXTERNAL_UNAUTHORIZED, no Retry-After)', type: ApiErrorDto })
  async globalHealth(@Headers('x-correlation-id') correlationId?: string): Promise<{ healthy: boolean; version: string }> {
    return this.opencode.globalHealth(correlationId ?? '');
  }
}
