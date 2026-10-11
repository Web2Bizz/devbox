import { Injectable, Optional } from '@nestjs/common';
import type {
  ChatMessage,
  MessagesResponse,
  SendChatResponse,
  Session,
} from '../contracts.js';
import { OpencodeService } from '../opencode/opencode.service.js';
import { AppLogger } from '../common/app-logger.service.js';
import { ExternalClient } from '../common/external/external-client.js';
import { fromStatus, fromUnknown } from '../common/external/external-error.js';

/**
 * ProxyService — forwards /api/v1/* to the opencode server.
 * Upstream URL + fetch budget come from OpencodeService (single
 * owner of OPENCODE_*); this service never touches process.env directly.
 *
 * Retry policy (ExternalClient, EXTERNAL_RETRY_* tuning):
 * - GET (getSession/getMessages) → bounded retry on 429/5xx/timeout/network.
 * - POST (sendChat) → exactly ONE attempt by default (non-idempotent guard);
 *   pass `{ allowRetry: true }` only when the upstream chat endpoint is
 *   provably idempotent for the caller.
 * Upstream failures (even after retries) throw ExternalServiceError —
 * the api-error.filter answers 503 EXTERNAL_UNAVAILABLE
 * («сервис временно недоступен, повторите позже») with a Retry-After
 * header. No mock 200s: a 200 always means live upstream data
 * (warn + debug via AppLogger, never logs secrets — no URLs/headers/bodies
 * in logs).
 */
@Injectable()
export class ProxyService {
  private readonly external: ExternalClient;

  constructor(
    private readonly opencode: OpencodeService,
    private readonly logger: AppLogger = new AppLogger('ProxyService'),
    @Optional() externalClient?: ExternalClient,
  ) {
    this.external = externalClient ?? new ExternalClient(new AppLogger('ExternalClient'));
  }

  private baseUrl(): string {
    return this.opencode.dialUrl();
  }

  async getSession(correlationId: string): Promise<Session> {
    try {
      const upstream = await this.external.fetchWithRetry(`${this.baseUrl()}/session`, {
        headers: { 'x-correlation-id': correlationId },
      }, { service: 'opencode', operation: 'getSession', correlationId });
      const data = (await upstream.json().catch(() => null)) as Session | null;
      if (upstream.ok && data && typeof data.id === 'string') return data;
      throw fromStatus('opencode', 'getSession', upstream.status);
    } catch (err) {
      this.logger.warn('[proxy] /api/v1/session upstream failed', correlationId);
      this.logger.debug((err as Error).message, correlationId);
      throw fromUnknown('opencode', 'getSession', err);
    }
  }

  async getMessages(sessionId: string, correlationId: string): Promise<MessagesResponse> {
    try {
      const upstream = await this.external.fetchWithRetry(
        `${this.baseUrl()}/messages?sessionId=${encodeURIComponent(sessionId)}`,
        { headers: { 'x-correlation-id': correlationId } },
        { service: 'opencode', operation: 'getMessages', correlationId },
      );
      const data = (await upstream.json().catch(() => null)) as unknown;
      if (upstream.ok && data) return data as MessagesResponse;
      throw fromStatus('opencode', 'getMessages', upstream.status);
    } catch (err) {
      this.logger.warn('[proxy] /api/v1/messages upstream failed', correlationId);
      this.logger.debug((err as Error).message, correlationId);
      throw fromUnknown('opencode', 'getMessages', err);
    }
  }

  async sendChat(
    sessionId: string | undefined,
    message: string,
    correlationId: string,
    opts: { allowRetry?: boolean } = {},
  ): Promise<SendChatResponse> {
    try {
      const upstream = await this.external.fetchWithRetry(`${this.baseUrl()}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId },
        body: JSON.stringify({ sessionId, message }),
      }, {
        service: 'opencode',
        operation: 'sendChat',
        correlationId,
        // Non-idempotent guard: one attempt unless the caller explicitly opts in.
        allowNonIdempotentRetry: opts.allowRetry ?? false,
      });
      const data = (await upstream.json().catch(() => null)) as unknown;
      if (upstream.ok && data) return data as SendChatResponse;
      throw fromStatus('opencode', 'sendChat', upstream.status);
    } catch (err) {
      this.logger.warn('[proxy] /api/v1/chat upstream failed', correlationId);
      this.logger.debug((err as Error).message, correlationId);
      throw fromUnknown('opencode', 'sendChat', err);
    }
  }
}
