import { ApiClientError, api } from './client';
import { getValidAccessToken, refreshAccessToken } from '../lib/auth-store';
import { SessionExpiredError } from '../lib/session-expired';
import type {
  CreateSessionRequest,
  SessionInfo,
  SessionMessage,
  SessionRunStatusMap,
  SessionStreamFrame,
} from '@rush-code/contracts';
import { sessionStreamFrameSchema } from '@rush-code/contracts';

/**
 * sessions-client — the browser domain client for `/api/sessions*`.
 *
 * The frontend knows NOTHING about the underlying session runner: every
 * call goes through the product contract (`@rush-code/contracts` types,
 * boundaries enforced in ./client via parseBoundary), never an sdk, never
 * the deprecated `/api/opencode/*` aliases — except the two documented
 * exceptions in ./client (interrupt + provider inventory, TODO(card 6)).
 *
 * Auth (unchanged semantics from the pre-domain client):
 * - `withAuth` resolves the access token through `getValidAccessToken`
 *   (lib/auth-store, single-flight POST /auth/refresh) and sends it as
 *   `authorization: Bearer`; one silent `refreshAccessToken()` retry on an
 *   honest 401, then `SessionExpiredError` (dead session — never a
 *   masked 400/404: those propagate as the raw ApiClientError envelope).
 *   The token is never logged.
 * - `ensureSessionAuth()` pre-warms that refresh for explicit-mutating
 *   callers (create/abort/send) — same call sites as the old proxy client.
 */
async function withAuth<T>(call: (token: string) => Promise<T>): Promise<T> {
  const token = await getValidAccessToken();
  if (!token) throw new SessionExpiredError();
  try {
    return await call(token);
  } catch (e) {
    if (e instanceof ApiClientError && e.status === 401) {
      const retryToken = await refreshAccessToken();
      if (!retryToken) throw new SessionExpiredError();
      return call(retryToken);
    }
    throw e;
  }
}

/**
 * Thin wrapper over `getValidAccessToken`: refreshes a stale/expired access
 * into memory so the immediately following call reads a fresh token. The
 * result is discarded — only the side effect matters. No session → resolves
 * null and `withAuth` throws SessionExpiredError (honest, never masked).
 */
export async function ensureSessionAuth(): Promise<void> {
  try {
    await getValidAccessToken();
  } catch {
    // No session / refresh failed — withAuth surfaces it honestly below.
  }
}

export function listSessions(
  projectId: string,
  opts?: { signal?: AbortSignal },
): Promise<SessionInfo[]> {
  return withAuth((token) => api.listSessions(token, projectId, opts));
}

export function getSessionStatuses(
  projectId: string,
  opts?: { signal?: AbortSignal },
): Promise<SessionRunStatusMap> {
  return withAuth((token) => api.getSessionStatuses(token, projectId, opts));
}

export function createSession(body: CreateSessionRequest): Promise<SessionInfo> {
  return withAuth((token) => api.createSession(token, body));
}

export function listSessionMessages(
  projectId: string,
  sessionId: string,
  opts?: { limit?: number; cursor?: string; signal?: AbortSignal },
): Promise<SessionMessage[]> {
  return withAuth((token) => api.listSessionMessages(token, sessionId, projectId, opts));
}

export function sendSessionMessage(
  projectId: string,
  sessionId: string,
  text: string,
  opts?: { signal?: AbortSignal },
): Promise<SessionMessage> {
  return withAuth((token) =>
    api.sendSessionMessage(token, sessionId, { projectId, text }, opts),
  );
}

/**
 * Interrupt — TODO(card 6): no domain route yet, rides the deprecated
 * mirror alias (see api.abortSession). Best-effort at the callers (stop()
 * keeps the partial answer locally regardless of the outcome).
 */
export function abortSession(projectId: string, sessionId: string): Promise<void> {
  return withAuth((token) => api.abortSession(token, sessionId, projectId));
}

/**
 * Provider inventory — TODO(card 6): no domain route yet, rides the
 * deprecated mirror alias (see api.providers). The answer is the runner's
 * provider-list envelope passed through as-is (unknown by contract, nothing
 * invented): `fetchRunnerProviders` only unwraps it to an array of records
 * when the wire really carries one.
 */
export async function fetchRunnerProviders(query?: {
  projectId?: string;
  directory?: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>[]> {
  const res = await withAuth((token) => api.providers(token, query));
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  const rows = (res as { data?: unknown } | null)?.data;
  if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  throw new ApiClientError({
    code: 'shape_mismatch',
    message: 'contract mismatch on GET providers: no provider list in the answer',
    status: 0,
    correlationId: 'client',
  });
}

/**
 * SSE live frames of GET /api/sessions/events as domain
 * SessionStreamFrame rows. Every `data:` payload is parsed with
 * sessionStreamFrameSchema — a malformed frame FAILS LOUD (throws out of
 * the generator; the caller treats it as a stream break and redials with
 * backoff), never a silent cast or default. Heartbeat comments (lines
 * without `data:`) are not frames and are skipped by transport framing,
 * not by guessing shapes. Cancellation arrives via the caller's
 * AbortSignal: it reaches the fetch body reader (no sdk stream to close —
 * plain fetch is the transport here).
 */
export async function* sessionEventStream(
  projectId: string,
  signal: AbortSignal,
): AsyncGenerator<SessionStreamFrame, void, undefined> {
  const res = await withAuth((token) => api.streamSessionEvents(token, projectId, { signal }));
  const body = res.body;
  if (!body) {
    throw new ApiClientError({
      code: 'no_stream_body',
      message: 'event stream answer carried no body',
      status: 0,
      correlationId: 'client',
    });
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; CRLF normalized first.
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          const parsed: unknown = JSON.parse(payload);
          const frame = sessionStreamFrameSchema.parse(parsed);
          yield frame;
        }
      }
    }
  } finally {
    // Downstream gone (unmount/reconnect/abort): release + cancel the
    // body reader best-effort so the socket is not pinned.
    try {
      reader.cancel().catch(() => null);
    } catch {
      /* already closed — noop */
    }
    try {
      reader.releaseLock();
    } catch {
      /* stream already released — noop */
    }
  }
}

/**
 * Human-readable message for a thrown transport error. Never surfaces
 * secrets — only name/message/status are read.
 */
export function toErrorMessage(error: unknown): string {
  if (error === undefined || error === null) return 'Unexpected error';
  if (typeof error === 'string') return error || 'Unexpected error';
  if (error instanceof Error) return error.message || 'Unexpected error';
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const data = obj.data as Record<string, unknown> | undefined;
    if (data && typeof data.message === 'string' && data.message) return data.message;
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.name === 'string' && obj.name) return obj.name;
  }
  return 'Unexpected error';
}
