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
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type {
  EventSubscribeData,
  GlobalEventData,
  Session,
  SessionCommandData,
  SessionForkData,
  SessionMessagesData,
  SessionPromptAsyncData,
  SessionPromptData,
  SessionShellData,
  SessionUpdateData,
} from '@opencode-ai/sdk';
import { OpencodeSdkClient } from './opencode-client.js';
import { OpencodeService } from './opencode.service.js';
import { AppLogger } from '../common/app-logger.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
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
} from '../api/dto.js';
import { fromUnknown } from '../common/external/external-error.js';

/** Upstream cursor headers passed through on GET message lists (when present). */
const CURSOR_PASSTHROUGH_HEADERS = ['x-next-cursor', 'link'] as const;

type SseSubscription = {
  stream: AsyncIterable<unknown> & { return?: (v?: unknown) => Promise<unknown> };
};

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
 * Behavior mirrors ProxyService: upstream failures (even after the
 * ExternalClient retry budget inside OpencodeSdkClient) throw
 * ExternalServiceError — the api-error.filter answers 503
 * EXTERNAL_UNAVAILABLE («сервис временно недоступен, повторите позже»)
 * with a Retry-After header. No mock 200s: a 200 always means live
 * upstream data (warn + debug via AppLogger, never logs secrets —
 * no URLs/headers/bodies).
 */
@ApiTags('opencode')
@Controller('opencode')
export class OpencodeController {
  constructor(
    private readonly sdk: OpencodeSdkClient,
    private readonly opencode: OpencodeService,
    private readonly logger: AppLogger = new AppLogger('OpencodeController'),
  ) {}

  private isUpstreamOk<T>(data: T | undefined, error: unknown): data is T {
    return data !== undefined && error === undefined;
  }

  private upstreamError(operation: string, error: unknown): Error {
    return fromUnknown('opencode', operation, error ?? new Error('upstream_error'));
  }

  /**
   * Merge optional query keys onto sdk options. The pinned sdk query types
   * lag the upstream OpenAPI (e.g. no `before` on session.messages yet —
   * see contracts/opencode-upstream.json); extra keys are forwarded at
   * runtime so the proxy stays 1:1 without waiting for the sdk.
   */
  private withQuery<T extends object>(
    base: T,
    query: Record<string, string | number | undefined>,
  ): T {
    const clean = Object.fromEntries(
      Object.entries(query).filter(([, v]) => v !== undefined),
    );
    return { ...base, ...(Object.keys(clean).length > 0 ? { query: clean } : {}) } as T;
  }

  /**
   * Copy upstream cursor headers (x-next-cursor/Link, when present) onto
   * the downstream JSON response. The hey-api client exposes the raw fetch
   * Response on the result tuple (`response` field, responseStyle 'fields').
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

  private isAbortError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { name?: unknown; code?: unknown; cause?: unknown };
    if (e.name === 'AbortError') return true;
    if (e.code === 20) return true;
    // DOMException AbortError may be wrapped (e.g. in cause)
    if (e.cause && typeof e.cause === 'object') {
      const c = e.cause as { name?: unknown; code?: unknown };
      if (c.name === 'AbortError' || c.code === 20) return true;
    }
    return false;
  }

  private async relaySse(
    operation: string,
    cid: string,
    req: ExpressRequest,
    res: ExpressResponse,
    subscribe: (signal: AbortSignal) => Promise<SseSubscription>,
  ): Promise<void> {
    // Fail fast when upstream is unreachable. The sdk SSE client reconnects
    // forever (its first `next()` never rejects while down), so without a
    // probe a down upstream would answer 200 with an infinite silent stream
    // instead of 503 EXTERNAL_UNAVAILABLE. The probe never throws and never
    // logs secrets; only after it says up do we send SSE headers (a 200
    // stream then carries live upstream frames only — no mock frames).
    // NOTE: the sdk SSE path uses global fetch (not the ExternalClient
    // transport), so liveness here is probe + downstream-close abort.
    if ((await this.opencode.checkConnectivity()) === 'down') {
      this.logger.warn(`[opencode] ${operation} upstream failed`, cid);
      throw this.upstreamError(operation, new Error('unreachable'));
    }
    // AbortSignal reaches the sdk generator (options.signal) so a
    // downstream disconnect stops the upstream fetch; backoff is capped so
    // cleanup never hangs the handler. Retries stay unbounded while live
    // (re-stream semantics across transient drops).
    const upstream = new AbortController();
    let sub: SseSubscription;
    try {
      sub = await subscribe(upstream.signal);
    } catch (err) {
      // Client went away before subscribe resolved: upstream.abort()
      // surfaces here as AbortError — штатный disconnect, не 503.
      if (this.isAbortError(err)) {
        this.logger.debug('[opencode] client disconnected before subscribe', cid);
        return;
      }
      this.logger.warn(`[opencode] ${operation} upstream failed`, cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError(operation, err);
    }
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.setHeader('x-correlation-id', cid || 'none');
    res.flushHeaders();

    let closed = false;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      try {
        upstream.abort();
      } catch {
        /* abort is idempotent — never throws outward */
      }
    };
    // upstream.abort() may throw DOMException AbortError synchronously
    // inside EventEmitter emit — swallow it here so it never escapes as
    // unhandledRejection (Bun prints it as line:127 onClose→emitCloseNT).
    const onCloseSafe = (): void => {
      try {
        onClose();
      } catch {
        /* disconnect — noop */
      }
    };
    req.on('close', onCloseSafe);
    // Socket errors after disconnect would otherwise bubble as unhandled
    // 'error' events on the request — swallow, close handler does cleanup.
    req.on('error', () => {
      /* downstream socket error — noop, handled via close */
    });

    try {
      const it = sub.stream[Symbol.asyncIterator]();
      while (!closed && !req.destroyed) {
        let next: IteratorResult<unknown>;
        try {
          next = await it.next();
        } catch (err) {
          // AbortError from the sdk generator on downstream disconnect —
          // штатный disconnect, выходим молча без stack.
          if (this.isAbortError(err) || closed) {
            this.logger.debug('[opencode] client disconnected', cid);
            break;
          }
          throw err;
        }
        if (next.done || closed || req.destroyed) break;
        try {
          res.write(`data: ${JSON.stringify(next.value)}\n\n`);
        } catch (err) {
          // Write after downstream close — то же, что disconnect.
          if (this.isAbortError(err) || closed || req.destroyed) {
            this.logger.debug('[opencode] client disconnected', cid);
            break;
          }
          throw err;
        }
      }
    } catch (err) {
      // Mid-stream failure: status is already 200, just close the stream
      // (message only, never secrets). AbortError — штатный disconnect.
      if (this.isAbortError(err)) {
        this.logger.debug('[opencode] client disconnected', cid);
      } else {
        this.logger.debug(`[opencode] event stream interrupted: ${(err as Error).message}`, cid);
      }
    } finally {
      req.removeListener('close', onCloseSafe);
      if (!closed) {
        closed = true;
        try {
          upstream.abort();
        } catch {
          /* noop */
        }
      }
      // Best-effort cancel: the sdk generator may sit out a reconnect
      // backoff — bound the wait so the handler never hangs. AbortError
      // from return() — штатный disconnect, глотаем молча.
      await Promise.race([
        (async (): Promise<void> => {
          try {
            await sub.stream.return?.(undefined);
          } catch (err) {
            if (!this.isAbortError(err)) {
              /* non-abort cleanup errors are also best-effort — noop */
            }
          }
        })(),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    if (!req.destroyed && !res.writableEnded && !res.destroyed) {
      try {
        res.end();
      } catch (err) {
        if (!this.isAbortError(err)) {
          this.logger.debug(
            `[opencode] event stream end failed: ${(err as Error).message}`,
            cid,
          );
        }
      }
    }
  }

  // --- sessions -----------------------------------------------------------

  @Get('session')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List sessions (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live sessions' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async listSessions(
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Session[]> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.list(
        directory ? { query: { directory } } : undefined,
      );
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('listSessions', res.error);
    } catch (err) {
      this.logger.warn('[opencode] GET /session upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('listSessions', err);
    }
  }

  @Post('session')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create session (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live session' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async createSession(
    @Body() body: { title?: string; parentID?: string } = {},
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Session> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.create({
        body: { title: body?.title, parentID: body?.parentID },
        ...(directory ? { query: { directory } } : {}),
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('createSession', res.error);
    } catch (err) {
      this.logger.warn('[opencode] POST /session upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('createSession', err);
    }
  }

  @Get('session/status')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Get session status (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live session status map' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async sessionStatus(
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.status(
        directory ? { query: { directory } } : undefined,
      );
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('sessionStatus', res.error);
    } catch (err) {
      this.logger.warn('[opencode] GET /session/status upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('sessionStatus', err);
    }
  }

  @Get('session/:id')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Get session (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live session' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async getSession(
    @Param('id') id: string,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Session> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.get({
        path: { id },
        ...(directory ? { query: { directory } } : {}),
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('getSession', res.error);
    } catch (err) {
      this.logger.warn('[opencode] GET /session/:id upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('getSession', err);
    }
  }

  @Delete('session/:id')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Delete session (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'deleted flag (live upstream only)' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async deleteSession(
    @Param('id') id: string,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<{ deleted: boolean }> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.delete({
        path: { id },
        ...(directory ? { query: { directory } } : {}),
      });
      if (res.error === undefined) return { deleted: true };
      throw this.upstreamError('deleteSession', res.error);
    } catch (err) {
      this.logger.warn('[opencode] DELETE /session/:id upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('deleteSession', err);
    }
  }

  @Patch('session/:id')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Update session (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live session' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async updateSession(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodeSessionUpdateSchema))
    body: OpencodeSessionUpdateInput,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Session> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.update(
        this.withQuery(
          { path: { id }, body: { ...body } as SessionUpdateData['body'] },
          { directory },
        ),
      );
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('updateSession', res.error);
    } catch (err) {
      this.logger.warn('[opencode] PATCH /session/:id upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('updateSession', err);
    }
  }

  @Post('session/:id/fork')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fork session (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live forked session' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async forkSession(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodeForkSchema))
    body: OpencodeForkInput = {},
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Session> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.fork(
        this.withQuery(
          { path: { id }, body: { ...body } as SessionForkData['body'] },
          { directory },
        ),
      );
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('forkSession', res.error);
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/fork upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('forkSession', err);
    }
  }

  // --- messages -----------------------------------------------------------

  @Get('session/:id/message')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List session messages (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live messages' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async listMessages(
    @Param('id') id: string,
    @Query('directory') directory?: string,
    @Query('limit') limitRaw?: string,
    @Query('before') before?: string,
    @Res({ passthrough: true }) res?: ExpressResponse,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    try {
      const limit = this.parseLimit(limitRaw);
      const sdkRes = await (await this.sdk.create(cid)).session.messages(
        this.withQuery({ path: { id } }, { directory, limit, before }) as SessionMessagesData,
      );
      if (this.isUpstreamOk(sdkRes.data, sdkRes.error)) {
        this.passthroughCursors(sdkRes, res);
        return sdkRes.data;
      }
      throw this.upstreamError('listMessages', sdkRes.error);
    } catch (err) {
      this.logger.warn('[opencode] GET /session/:id/message upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw err instanceof BadRequestException
        ? err
        : this.upstreamError('listMessages', err);
    }
  }

  @Get('session/:id/message/:messageID')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Get session message (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live message' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async getMessage(
    @Param('id') id: string,
    @Param('messageID') messageID: string,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.message({
        path: { id, messageID },
        ...(directory ? { query: { directory } } : {}),
      });
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('getMessage', res.error);
    } catch (err) {
      this.logger.warn('[opencode] GET /session/:id/message/:messageID upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('getMessage', err);
    }
  }

  @Post('session/:id/message')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send session message (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live assistant reply' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async prompt(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodePromptSchema))
    body: OpencodePromptInput,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.prompt(
        this.withQuery(
          { path: { id }, body: { ...body } as SessionPromptData['body'] },
          { directory },
        ),
      );
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('prompt', res.error);
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/message upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('prompt', err);
    }
  }

  @Post('session/:id/prompt_async')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Send async session message, return immediately (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 204, description: 'prompt accepted (live upstream only)' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async promptAsync(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodePromptSchema))
    body: OpencodePromptInput,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.promptAsync(
        this.withQuery(
          { path: { id }, body: { ...body } as SessionPromptAsyncData['body'] },
          { directory },
        ),
      );
      if (res.error !== undefined) throw this.upstreamError('promptAsync', res.error);
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/prompt_async upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('promptAsync', err);
    }
  }

  @Post('session/:id/command')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send command to session (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live assistant reply' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async runCommand(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodeCommandSchema))
    body: OpencodeCommandInput,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.command(
        this.withQuery(
          { path: { id }, body: { ...body } as SessionCommandData['body'] },
          { directory },
        ),
      );
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('runCommand', res.error);
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/command upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('runCommand', err);
    }
  }

  @Post('session/:id/shell')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run shell command in session (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live created message' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async runShell(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opencodeShellSchema))
    body: OpencodeShellInput,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.shell(
        this.withQuery(
          { path: { id }, body: { ...body } as SessionShellData['body'] },
          { directory },
        ),
      );
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('runShell', res.error);
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/shell upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('runShell', err);
    }
  }

  @Post('session/:id/abort')
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abort session (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'abort result (live upstream only)' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async abortSession(
    @Param('id') id: string,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).session.abort({
        path: { id },
        ...(directory ? { query: { directory } } : {}),
      });
      if (res.error === undefined) return res.data ?? { aborted: true };
      throw this.upstreamError('abortSession', res.error);
    } catch (err) {
      this.logger.warn('[opencode] POST /session/:id/abort upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('abortSession', err);
    }
  }

  // --- providers ----------------------------------------------------------

  @Get('config/providers')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List providers (sdk → opencode server, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live providers' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async listProviders(
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<unknown> {
    const cid = correlationId ?? '';
    try {
      const res = await (await this.sdk.create(cid)).config.providers(
        directory ? { query: { directory } } : undefined,
      );
      if (this.isUpstreamOk(res.data, res.error)) return res.data;
      throw this.upstreamError('listProviders', res.error);
    } catch (err) {
      this.logger.warn('[opencode] GET /config/providers upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('listProviders', err);
    }
  }

  // --- events (SSE re-stream) ---------------------------------------------

  @Get('global/event')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Subscribe to opencode events (SSE re-stream, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'text/event-stream of upstream GlobalEvent frames' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async streamEvents(
    @Req() req: ExpressRequest,
    @Res() res: ExpressResponse,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    const cid = correlationId ?? '';
    await this.relaySse('GET /global/event', cid, req, res, (signal) =>
      this.sdk.create(cid).then(
        (client) =>
          client.global.event({
            signal,
            sseDefaultRetryDelay: 500,
            sseMaxRetryDelay: 2000,
          } as unknown as GlobalEventData) as unknown as Promise<SseSubscription>,
      ),
    );
  }

  @Get('event')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Subscribe to legacy opencode events (SSE re-stream, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'text/event-stream of upstream Event frames' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async streamLegacyEvents(
    @Req() req: ExpressRequest,
    @Res() res: ExpressResponse,
    @Query('directory') directory?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    const cid = correlationId ?? '';
    await this.relaySse('GET /event', cid, req, res, (signal) =>
      this.sdk.create(cid).then(
        (client) =>
          client.event.subscribe({
            signal,
            sseDefaultRetryDelay: 500,
            sseMaxRetryDelay: 2000,
            ...(directory ? { query: { directory } } : {}),
          } as unknown as EventSubscribeData) as unknown as Promise<SseSubscription>,
      ),
    );
  }

  // --- health -------------------------------------------------------------

  @Get('global/health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Opencode server health (passthrough, 503 when unreachable)' })
  @ApiResponse({ status: 200, description: 'live upstream health ({healthy, version})' })
  @ApiResponse({ status: 503, description: 'opencode server unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async globalHealth(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<{ healthy: boolean; version: string }> {
    // The pinned sdk exposes no global.health (only global.event), so this
    // one goes through OpencodeService.fetchWithRetry directly (same
    // REQUEST_TIMEOUT_MS budget + idempotent retry as the sdk transport).
    const cid = correlationId ?? '';
    try {
      const res = await this.opencode.fetchWithRetry(
        `${this.opencode.dialUrl()}/global/health`,
        { method: 'GET' },
        { operation: 'globalHealth' },
      );
      if (!res.ok) throw this.upstreamError('globalHealth', new Error(`status_${res.status}`));
      const body = (await res.json().catch(() => null)) as unknown;
      if (
        typeof body !== 'object' ||
        body === null ||
        (body as { healthy?: unknown }).healthy !== true ||
        typeof (body as { version?: unknown }).version !== 'string'
      ) {
        throw this.upstreamError('globalHealth', new Error('bad_health_shape'));
      }
      return body as { healthy: boolean; version: string };
    } catch (err) {
      this.logger.warn('[opencode] GET /global/health upstream failed', cid);
      this.logger.debug((err as Error).message, cid);
      throw this.upstreamError('globalHealth', err);
    }
  }
}
