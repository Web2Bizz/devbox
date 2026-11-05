import { ApiClientError, api } from './client';
import { withAuth, toErrorMessage } from './sessions-client';
import { runStreamFrameSchema } from '@rush-code/contracts';
import type { CreateRunRequest, RunInfo, RunInfoList, RunStreamFrame } from '@rush-code/contracts';

/**
 * runs-client — the browser domain client for `/api/v1/runs*`.
 *
 * Same stance as sessions-client: every call goes through the product
 * contract (`@rush-code/contracts` types, boundaries enforced in ./client
 * via parseBoundary), auth rides `withAuth` (single-flight refresh + one
 * silent retry), and the SSE answer keeps the Response open — the frame
 * parser below is the streaming exception (no JSON buffering).
 */

export function listRuns(projectId: string, opts?: { signal?: AbortSignal }): Promise<RunInfoList> {
  return withAuth((token) => api.listRuns(token, projectId, opts));
}

export function createRun(body: CreateRunRequest): Promise<RunInfo> {
  return withAuth((token) => api.createRun(token, body));
}

export function getRun(runId: string, opts?: { signal?: AbortSignal }): Promise<RunInfo> {
  return withAuth((token) => api.getRun(token, runId, opts));
}

/** SSE parser over an already-open Response (pure — no auth, testable). */
export async function* runFrameStream(
  res: Response,
): AsyncGenerator<RunStreamFrame, void, undefined> {
  const body = res.body;
  if (!body) {
    throw new ApiClientError({
      code: 'no_stream_body',
      message: 'run event stream answer carried no body',
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
        // One SSE dispatch may carry its payload on several `data:` lines
        // (chunked JSON) — join them with '\n' into ONE payload and parse
        // once. Lines without `data:` are heartbeat/comment framing.
        const dataLines: Array<string> = [];
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue; // heartbeat/comment
          dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const payload = dataLines.join('\n');
        if (!payload) continue;
        const parsed: unknown = JSON.parse(payload); // malformed → throw (fail loud)
        yield runStreamFrameSchema.parse(parsed);
      }
    }
  } finally {
    // Downstream gone (unmount/reconnect/abort): release + cancel the body
    // reader best-effort so the socket is not pinned.
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

/** Live run journal frames (GET /api/v1/runs/:id/events?cursor=). */
export async function* runEventStream(
  runId: string,
  cursor: number,
  signal: AbortSignal,
): AsyncGenerator<RunStreamFrame, void, undefined> {
  const res = await withAuth((token) => api.streamRunEvents(token, runId, cursor, { signal }));
  yield* runFrameStream(res);
}

export { toErrorMessage };
