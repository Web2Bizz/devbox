import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UsePipes,
  Version,
} from '@nestjs/common';
import {
  ApiBody,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProxyService } from './proxy.service';
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
 * - canonical:  GET/POST /api/v1/session|messages|chat  (@Version('1'))
 * - removed:    unversioned /api/* aliases → 404 { code: 'not_found', … }
 * - reserved:   /api/v2/* → 404 { code: 'not_found', … } (no v2 handlers)
 */
@ApiTags('proxy')
@Controller()
export class ApiController {
  constructor(private readonly proxy: ProxyService) {}

  // --- v1 (canonical) -------------------------------------------------------

  @Get('session')
  @Version(DEFAULT_API_VERSION)
  @V1Endpoint('Active session (proxy → opencode server, 503 when unreachable)')
  @ApiResponse({ status: 200, description: 'live session', type: SessionDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async getSessionV1(@Headers('x-correlation-id') correlationId?: string): Promise<SessionDto> {
    return this.proxy.getSession(correlationId ?? '');
  }

  @Get('messages')
  @Version(DEFAULT_API_VERSION)
  @V1Endpoint('Session messages (proxy → opencode server, 503 when unreachable)')
  @ApiQuery({ name: 'sessionId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'live messages', type: MessagesResponseDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async getMessagesV1(
    @Query('sessionId') sessionId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<MessagesResponseDto> {
    return this.proxy.getMessages(sessionId ?? '', correlationId ?? '');
  }

  @Post('chat')
  @Version(DEFAULT_API_VERSION)
  @V1Endpoint('Send chat message (proxy → opencode server, 503 when unreachable)')
  @HttpCode(HttpStatus.OK) // contract promises 200 (not Nest's POST-default 201)
  @ApiBody({ type: SendChatRequestDto })
  @ApiResponse({ status: 200, description: 'live assistant reply', type: SendChatResponseDto })
  @ApiResponse({ status: 400, description: 'bad request', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  @UsePipes(new ZodValidationPipe(sendChatSchema))
  async sendChatV1(
    @Body() body: SendChatRequestDto,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<SendChatResponseDto> {
    return this.proxy.sendChat(body.sessionId, body.message, correlationId ?? '');
  }
}
