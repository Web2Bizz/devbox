import { ApiClientError, SEND_TIMEOUT_MS, api } from './client';
import { getValidAccessToken, refreshAccessToken } from '../lib/auth-store';
import { SessionExpiredError } from '../lib/session-expired';
import type {
  AgentInfo,
  CreateSessionRequest,
  RevertInfo,
  SessionForkResponse,
  SessionInfo,
  SessionInterruptResult,
  SessionMessage,
  SessionRunStatusMap,
  SessionRunnerProvider,
  SessionModel,
  SessionStreamFrame,
  SnapshotDiffList,
} from '@rush-code/contracts';
import { sessionStreamFrameSchema } from '@rush-code/contracts';

/**
 * sessions-client — the browser domain client for `/api/v1/sessions*`.
 *
 * The frontend knows NOTHING about the underlying session runner: every
 * call goes through the product contract (`@rush-code/contracts` types,
 * boundaries enforced in ./client via parseBoundary). As of card 6 the
 * two former mirror-alias exceptions (interrupt, provider inventory) are
 * domain routes too — no deprecated transport remains anywhere.
 *
 * Auth (unchanged semantics from the pre-domain client): `withAuth` below
 * resolves the access token through `getValidAccessToken` (lib/auth-store,
 * single-flight POST /auth/refresh) and sends it as `authorization: Bearer`;
 * one silent `refreshAccessToken()` retry on an honest 401, then
 * `SessionExpiredError` (dead session — never a masked 400/404: those
 * propagate as the raw ApiClientError envelope). The token is never logged.
 */

/**
 * Shared with runs-client (single-flight refresh + one silent retry).
 *
 * `ensureSessionAuth()` pre-warms that refresh for explicit-mutating
 * callers (create/abort/send) — same call sites as the old proxy client.
 */
export async function withAuth<T>(call: (token: string) => Promise<T>): Promise<T> {
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
): Promise<Array<SessionInfo>> {
  return withAuth((token) => api.listSessions(token, projectId, opts));
}

export function getSessionStatuses(
  projectId: string,
  opts?: { signal?: AbortSignal },
): Promise<SessionRunStatusMap> {
  return withAuth((token) => api.getSessionStatuses(token, projectId, opts));
}

export function createSession(
  body: CreateSessionRequest,
  opts?: { agentId?: string },
): Promise<SessionInfo> {
  return withAuth((token) =>
    api.createSession(token, opts?.agentId ? { ...body, agentId: opts.agentId } : body),
  );
}

export function listSessionMessages(
  projectId: string,
  sessionId: string,
  opts?: { limit?: number; cursor?: string; signal?: AbortSignal },
): Promise<Array<SessionMessage>> {
  return withAuth((token) => api.listSessionMessages(token, sessionId, projectId, opts));
}

/**
 * Long POST: POST /api/v1/sessions/:id/messages returns its receipt only after
 * the whole backend turn (Jev + an Auto chain of up to 7 sequential model
 * calls) — the answer itself streams over SSE, `sending` clears on the
 * session.idle frame (or stop()). The long default timeout (SEND_TIMEOUT_MS)
 * only guards the wait; abort arrives via the caller's AbortSignal from
 * stop()/unmount. POST errors stay surfacing (red error block), never
 * fire-and-forget.
 */
export function sendSessionMessage(
  projectId: string,
  sessionId: string,
  text: string,
  opts?: { signal?: AbortSignal; agentId?: string; timeoutMs?: number },
): Promise<SessionMessage> {
  return withAuth((token) =>
    api.sendSessionMessage(
      token,
      sessionId,
      opts?.agentId ? { projectId, text, agentId: opts.agentId } : { projectId, text },
      {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        timeoutMs: opts?.timeoutMs ?? SEND_TIMEOUT_MS,
      },
    ),
  );
}

/**
 * Interrupt a running session (POST /api/v1/sessions/{id}/interrupt).
 * The domain answer {interrupted} is honest data: false means the session
 * was idle (no-op), never an error. Best-effort at the callers — stop()
 * keeps the partial answer locally regardless of the outcome.
 */
export function interruptSession(
  projectId: string,
  sessionId: string,
): Promise<SessionInterruptResult> {
  return withAuth((token) => api.interruptSession(token, sessionId, { projectId }));
}

/**
 * Provider inventory for the project (GET /api/v1/sessions/providers) —
 * domain rows are the REQUIRED subset of the artifact Provider.Info
 * (id/name/activation/package), boundary-parsed in ./client. Credential-
 * bearing upstream members (settings/headers/body) never reach the
 * browser — the server projects them away, the client trusts nothing
 * unvalidated.
 */
export function listSessionProviders(
  projectId: string,
  opts?: { signal?: AbortSignal },
): Promise<Array<SessionRunnerProvider>> {
  return withAuth((token) => api.listSessionProviders(token, projectId, opts));
}

export function listSessionModels(
  projectId: string,
  opts?: { signal?: AbortSignal },
): Promise<Array<SessionModel>> {
  return withAuth((token) => api.listSessionModels(token, projectId, opts));
}

/**
 * Agent registry for the chat picker (GET /api/v1/agents) — domain
 * AgentInfo rows, boundary-parsed in ./client. Project-independent (the
 * registry is global), so no projectId travels.
 */
export function listAgents(opts?: { signal?: AbortSignal }): Promise<Array<AgentInfo>> {
  return withAuth((token) => api.listAgents(token, opts));
}

/**
 * Default agent answering chat turns (registry id of the Ask agent). Shared
 * by `useChat` (initial state) and the `AgentSelector` (fallback value) —
 * the server applies the same default when no agentId travels, so the three
 * never disagree.
 */
export const DEFAULT_AGENT_ID = 'ask';

/**
 * SSE live frames of GET /api/v1/sessions/events as domain
 * SessionStreamFrame rows. Fail-soft (C3): every `data:` payload is parsed as
 * `JSON.parse` in try + `sessionStreamFrameSchema.safeParse` (never `.parse`);
 * a broken chunk bumps a counter and is SKIPPED — the generator stays alive.
 * Heartbeat comments (`: ping`, no `data:`) are not frames: skipped, but they
 * count as activity for the caller's watchdog via `onActivity`. Transport
 * failures (fetch throw, `!body`, abort-tear) still throw outward — the caller
 * (useChat) decides quiet redial vs terminal; parse failures never throw.
 * `opts.sessionId` narrows the server subscription (`?session=`), `opts.lastEventId`
 * resumes after the cursor (`Last-Event-ID`, `?cursor=` fallback server-side).
 * No frame bodies are logged; `withAuth`/401 rotation is unchanged.
 *
 * Envelope stance: the schema stays permissive (`type: string`, variant-owned
 * `data`) so live reasoning (`session.reasoning.*`), tool lifecycle
 * (`session.tool.*`), text (`session.text.*`) and step/execution markers pass
 * through without loss — narrowing to `SessionReasoningFrame`,
 * `SessionToolLifecycleFrame`, `SessionTextDeltaFrame` and siblings happens in
 * `useChat` via safeParse (never a cast). Durable vs live: history is durable
 * (REST), these frames are live-only (cleared on reload, never persisted).
 */
export type SessionEventStreamOpts = {
  sessionId?: string;
  lastEventId?: string;
  onActivity?: () => void;
};

export async function* sessionEventStream(
  projectId: string,
  signal: AbortSignal,
  opts?: SessionEventStreamOpts,
): AsyncGenerator<SessionStreamFrame, void, undefined> {
  const response = await withAuth((token) =>
    api.streamSessionEvents(token, projectId, {
      signal,
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts?.lastEventId ? { lastEventId: opts.lastEventId } : {}),
    }),
  );
  const body = response.body;
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
  // Broken-chunk counter (metadata only — bodies never logged).
  let skipped = 0;
  const activity = opts?.onActivity;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; CRLF normalized first.
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const chunk = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        separatorIndex = buffer.indexOf('\n\n');
        // One SSE dispatch may carry its payload on several `data:` lines
        // (chunked JSON) — join them with '\n' into ONE payload and parse
        // once. Parsing line-by-line broke multi-line JSON; lines without
        // `data:` are heartbeat framing (`: ping`, `id:`) and stay skipped
        // as frames — while still signalling watchdog activity.
        const dataLines: Array<string> = [];
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) {
          // Heartbeat comment or id-only dispatch — liveness, not a frame.
          if (chunk.trim().length > 0) activity?.();
          continue;
        }
        const payload = dataLines.join('\n');
        if (!payload) {
          activity?.();
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          skipped += 1;
          continue;
        }
        const checked = sessionStreamFrameSchema.safeParse(parsed);
        if (!checked.success) {
          skipped += 1;
          continue;
        }
        activity?.();
        yield checked.data;
      }
    }
  } finally {
    void skipped;
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
 * Fork a session at a message boundary (POST /api/v1/sessions/{id}/fork).
 * `before` is the boundary message id; omitted → the whole thread is copied.
 */
export function forkSession(
  projectId: string,
  sessionId: string,
  before?: string,
): Promise<SessionForkResponse> {
  return withAuth((token) =>
    api.forkSession(token, sessionId, before ? { projectId, before } : { projectId }),
  );
}

/** Stage a revert of the files touched after a message boundary. */
export function stageRevert(
  projectId: string,
  sessionId: string,
  messageID: string,
  files?: Array<string>,
): Promise<RevertInfo> {
  return withAuth((token) =>
    api.stageSessionRevert(token, sessionId, files ? { projectId, messageID, files } : { projectId, messageID }),
  );
}

/** Discard the staged revert (files return to their pre-stage state). */
export function clearRevert(projectId: string, sessionId: string): Promise<void> {
  return withAuth((token) => api.clearSessionRevert(token, sessionId, projectId));
}

/** Keep the restored files and drop the staged revert state. */
export function commitRevert(projectId: string, sessionId: string): Promise<void> {
  return withAuth((token) => api.commitSessionRevert(token, sessionId, projectId));
}

/** Per-file diff between two session snapshots (git tree ids). */
export function snapshotDiff(
  projectId: string,
  sessionId: string,
  from: string,
  to: string,
  context?: number,
): Promise<SnapshotDiffList> {
  return withAuth((token) =>
    api.getSessionSnapshotDiff(token, sessionId, projectId, from, to, context !== undefined ? { context } : undefined),
  );
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
