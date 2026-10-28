import { HttpException, Injectable, Optional } from '@nestjs/common';
import type {
  ChatMessage,
  MessagesResponse,
  SendChatResponse,
  Session,
} from '@rush-code/contracts';
import { OpencodeService } from '../opencode/opencode.service';
import { AppLogger } from '../common/app-logger.service';
import { ExternalClient } from '../common/external/external-client';
import { ExternalServiceError, fromStatus, fromUnknown } from '../common/external/external-error';
import { OpencodeAuthService, serveBasicAuthHeader } from '../opencode-keys/opencode-auth.service';

/**
 * ProxyService — forwards /api/v1/* to the opencode server (v2 API surface).
 * Upstream URL + fetch budget come from OpencodeService (single
 * owner of OPENCODE_*); serve auth is the SERVER Basic password
 * (`serveBasicAuthHeader()` — Basic base64("opencode:<OPENCODE_PASSWORD>"),
 * the one source also used by OpencodeSdkClient). OpencodeAuthService stays
 * only as the real-user gate (non-uuid mock → 401). This service never touches
 * process.env directly.
 *
 * v2 endpoints (sdk.gen.js `url:` fields, path params use `sessionID`
 * with a capital D):
 * - getSession → GET /api/session (v2 list; the first entry is returned
 *   to preserve the single-Session contract).
 * - listSessions → GET /api/session (v2 list; every entry maps to the
 *   wire Session contract; empty stays 200 []).
 * - getMessages → GET /api/session/{sessionID}/message.
 * - sendChat → POST /api/session/{sessionID}/prompt
 *   `{ prompt: { text } }` (admit-only: the reply is read back via
 *   getMessages so the SendChatResponse contract holds); without a
 *   sessionId a session is created first via POST /api/session (v2
 *   `{ data }` envelope, unwrapped); then wait idle (best-effort, 5s).
 * Auth is the server `Authorization: Basic` header (OPENCODE_PASSWORD;
 * unset → no header, upstream 401 is the honest signal). The real-user gate
 * (non-uuid mock → 401 `unauthorized`) runs before any upstream call; there
 * is NO per-user DB Bearer on this path anymore (the token never leaves the
 * server, only auth=yes|no + scheme=basic presence is traced at debug).
 *
 * Retry policy (ExternalClient, EXTERNAL_RETRY_* tuning) — unchanged:
 * - GET (getSession/getMessages) → bounded retry on 429/5xx/timeout/network.
 * - POST (sendChat prompt, session create) → exactly ONE attempt by
 *   default (non-idempotent guard); pass `{ allowRetry: true }` only when
 *   the upstream chat endpoint is provably idempotent for the caller.
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
    private readonly auth: OpencodeAuthService,
    private readonly logger: AppLogger = new AppLogger('ProxyService'),
    @Optional() externalClient?: ExternalClient,
  ) {
    this.external = externalClient ?? new ExternalClient(new AppLogger('ExternalClient'));
  }

  private baseUrl(): string {
    return this.opencode.dialUrl();
  }

  /** Short wait budget for POST /api/session/{id}/wait in sendChat (reply race). */
  private readonly sendChatWaitMs = 5000;

  /** Serve auth headers (server Basic; real-user gate first, no header when password unset). */
  private async authHeaders(
    userId: string,
    correlationId: string,
  ): Promise<Record<string, string>> {
    this.auth.assertServeUser(userId, correlationId);
    return { 'x-correlation-id': correlationId, ...serveBasicAuthHeader() };
  }

  /** Map one native v2 SessionMessage to the wire ChatMessage contract. */
  private toChatMessage(entry: unknown, sessionId: string): ChatMessage | null {
    if (!entry || typeof entry !== 'object') return null;
    const msg = entry as {
      id?: unknown;
      type?: unknown;
      text?: unknown;
      content?: unknown;
      time?: { created?: unknown };
    };
    if (typeof msg.id !== 'string' || typeof msg.type !== 'string') return null;
    const role: ChatMessage['role'] =
      msg.type === 'assistant' ? 'assistant' : msg.type === 'user' ? 'user' : 'system';
    let content = '';
    if (typeof msg.text === 'string') {
      content = msg.text;
    } else if (Array.isArray(msg.content)) {
      content = (msg.content as Array<{ type?: unknown; text?: unknown }>)
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n\n');
    }
    if (!content) return null;
    const created = typeof msg.time?.created === 'number'
      ? new Date(msg.time.created).toISOString()
      : new Date().toISOString();
    return { id: msg.id, sessionId, role, content, createdAt: created };
  }

  /** Map one native v2 SessionV2Info entry to the wire Session contract. */
  private toSession(entry: unknown): Session | null {
    if (!entry || typeof entry !== 'object') return null;
    const v = entry as {
      id?: unknown;
      title?: unknown;
      createdAt?: unknown;
      model?: unknown;
      time?: unknown;
    };
    if (typeof v.id !== 'string' || v.id.length === 0) return null;
    const title =
      typeof v.title === 'string' && v.title.length > 0 ? v.title : 'Untitled';
    let createdAt: string | null = null;
    const timeCreated = (v.time as { created?: unknown } | undefined)?.created;
    if (typeof timeCreated === 'number' && Number.isFinite(timeCreated)) {
      createdAt = new Date(timeCreated).toISOString();
    } else if (typeof v.createdAt === 'number' && Number.isFinite(v.createdAt)) {
      createdAt = new Date(v.createdAt).toISOString();
    } else if (typeof v.createdAt === 'string' && v.createdAt.length > 0) {
      createdAt = v.createdAt;
    }
    if (!createdAt) return null;
    const session: Session = { id: v.id, title, createdAt };
    if (typeof v.model === 'string' && v.model.length > 0) {
      session.model = v.model;
    } else if (
      v.model &&
      typeof v.model === 'object' &&
      typeof (v.model as { modelID?: unknown }).modelID === 'string' &&
      ((v.model as { modelID: string }).modelID.length > 0)
    ) {
      session.model = (v.model as { modelID: string }).modelID;
    }
    return session;
  }

  /** Map a native v2 `{ data: SessionMessage[] }` payload to MessagesResponse. */
  private toMessagesResponse(payload: unknown, sessionId: string): MessagesResponse | null {
    if (!payload || typeof payload !== 'object') return null;
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) return null;
    const messages: ChatMessage[] = [];
    for (const entry of data) {
      const mapped = this.toChatMessage(entry, sessionId);
      if (mapped) messages.push(mapped);
    }
    return { sessionId, messages };
  }

  async getSession(userId: string, correlationId: string, projectDir?: string): Promise<Session> {
    try {
      const url =
        projectDir !== undefined
          ? `${this.baseUrl()}/api/session?directory=${encodeURIComponent(projectDir)}`
          : `${this.baseUrl()}/api/session`;
      const upstream = await this.external.fetchWithRetry(url, {
        headers: await this.authHeaders(userId, correlationId),
      }, { service: 'opencode', operation: 'getSession', correlationId });
      const data = (await upstream.json().catch(() => null)) as unknown;
      // v2 list shape: array (or `{ data: [...] }`); contract stays single.
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown })?.data)
          ? ((data as { data?: unknown }).data as unknown[])
          : null;
      const first = (Array.isArray(list) ? list[0] : data) as Session | null;
      if (upstream.ok && first && typeof first.id === 'string') return first;
      throw fromStatus('opencode', 'getSession', upstream.status);
    } catch (err) {
      if (err instanceof ExternalServiceError || err instanceof HttpException) throw err;
      this.logger.warn('[proxy] /api/v1/session upstream failed', correlationId);
      this.logger.debug((err as Error).message, correlationId);
      throw fromUnknown('opencode', 'getSession', err);
    }
  }

  async listSessions(
    userId: string,
    correlationId: string,
    projectDir?: string,
  ): Promise<Session[]> {
    try {
      const url =
        projectDir !== undefined
          ? `${this.baseUrl()}/api/session?directory=${encodeURIComponent(projectDir)}`
          : `${this.baseUrl()}/api/session`;
      const upstream = await this.external.fetchWithRetry(url, {
        headers: await this.authHeaders(userId, correlationId),
      }, { service: 'opencode', operation: 'listSessions', correlationId });
      const data = (await upstream.json().catch(() => null)) as unknown;
      if (!upstream.ok) throw fromStatus('opencode', 'listSessions', upstream.status);
      // v2 list shape: array (or `{ data: [...] }`); empty stays 200 [].
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown })?.data)
          ? ((data as { data?: unknown }).data as unknown[])
          : null;
      if (!list) throw fromUnknown('opencode', 'listSessions', new Error('bad_session_list_shape'));
      const sessions: Session[] = [];
      for (const entry of list) {
        const mapped = this.toSession(entry);
        if (mapped) sessions.push(mapped);
      }
      return sessions;
    } catch (err) {
      if (err instanceof ExternalServiceError || err instanceof HttpException) throw err;
      this.logger.warn('[proxy] /api/v1/sessions upstream failed', correlationId);
      this.logger.debug((err as Error).message, correlationId);
      throw fromUnknown('opencode', 'listSessions', err);
    }
  }

  async getMessages(userId: string, sessionId: string, correlationId: string): Promise<MessagesResponse> {
    try {
      const upstream = await this.external.fetchWithRetry(
        `${this.baseUrl()}/api/session/${encodeURIComponent(sessionId)}/message`,
        { headers: await this.authHeaders(userId, correlationId) },
        { service: 'opencode', operation: 'getMessages', correlationId },
      );
      const data = (await upstream.json().catch(() => null)) as unknown;
      const mapped = this.toMessagesResponse(data, sessionId);
      if (upstream.ok && mapped) return mapped;
      throw fromStatus('opencode', 'getMessages', upstream.status);
    } catch (err) {
      if (err instanceof ExternalServiceError || err instanceof HttpException) throw err;
      this.logger.warn('[proxy] /api/v1/messages upstream failed', correlationId);
      this.logger.debug((err as Error).message, correlationId);
      throw fromUnknown('opencode', 'getMessages', err);
    }
  }

  async sendChat(
    userId: string,
    sessionId: string | undefined,
    message: string,
    correlationId: string,
    opts: { allowRetry?: boolean } = {},
  ): Promise<SendChatResponse> {
    try {
      // v2 has no single /chat endpoint: prompt the session via
      // POST /api/session/{sessionID}/prompt (`{ prompt: { text } }`),
      // creating the session first via POST /api/session when needed.
      // Each POST runs once (non-idempotent guard preserved).
      let targetId = sessionId;
      if (!targetId) {
        const created = await this.external.fetchWithRetry(`${this.baseUrl()}/api/session`, {
          method: 'POST',
          headers: { ...(await this.authHeaders(userId, correlationId)), 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }, {
          service: 'opencode',
          operation: 'sendChat',
          correlationId,
          allowNonIdempotentRetry: opts.allowRetry ?? false,
        });
        // v2 envelope is `{ data: SessionV2Info }` (legacy top-level
        // `{ id }` kept as fallback) — only the id is needed here.
        const createdData = (await created.json().catch(() => null)) as
          | { data?: { id?: unknown }; id?: unknown }
          | null;
        const createdId = (createdData?.data as { id?: unknown } | undefined)?.id
          ?? createdData?.id;
        if (!created.ok || typeof createdId !== 'string') {
          throw fromStatus('opencode', 'sendChat', created.status);
        }
        targetId = createdId;
      }
      // v2 prompt admits the input (`{ data: SessionInputAdmitted }`, no
      // reply body) — the reply is read back below after the wait.
      const upstream = await this.external.fetchWithRetry(
        `${this.baseUrl()}/api/session/${encodeURIComponent(targetId)}/prompt`,
        {
          method: 'POST',
          headers: { ...(await this.authHeaders(userId, correlationId)), 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: { text: message } }),
        },
        {
          service: 'opencode',
          operation: 'sendChat',
          correlationId,
          // Non-idempotent guard: one attempt unless the caller explicitly opts in.
          allowNonIdempotentRetry: opts.allowRetry ?? false,
        },
      );
      if (!upstream.ok) throw fromStatus('opencode', 'sendChat', upstream.status);
      // v2 prompt admits immediately while the agent loop runs async —
      // briefly wait for idle (v2 `POST /api/session/{id}/wait`, bounded by
      // sendChatWaitMs) so the read-back below usually finds the assistant
      // reply instead of racing it. Best-effort: any wait failure falls
      // through to the read-back (503 when still no reply, as before).
      try {
        await this.external.fetchWithRetry(
          `${this.baseUrl()}/api/session/${encodeURIComponent(targetId)}/wait`,
          {
            method: 'POST',
            headers: await this.authHeaders(userId, correlationId),
          },
          {
            service: 'opencode',
            operation: 'sendChat',
            correlationId,
            timeoutMs: this.sendChatWaitMs,
            allowNonIdempotentRetry: false,
          },
        );
      } catch {
        /* wait is best-effort — the read-back below decides 200 vs 503 */
      }
      // v2 prompt admits without a reply body — read the reply back so a
      // 200 still means live upstream data (no mock 200s). The last
      // assistant message is the reply; fall back to the last message.
      const reply = await this.getMessages(userId, targetId, correlationId);
      const reversed = [...reply.messages].reverse();
      const assistant = reversed.find((m) => m.role === 'assistant') ?? reversed[0];
      if (!assistant) throw fromStatus('opencode', 'sendChat', upstream.status);
      return { sessionId: targetId, message: assistant };
    } catch (err) {
      if (err instanceof ExternalServiceError || err instanceof HttpException) throw err;
      this.logger.warn('[proxy] /api/v1/chat upstream failed', correlationId);
      this.logger.debug((err as Error).message, correlationId);
      throw fromUnknown('opencode', 'sendChat', err);
    }
  }
}
