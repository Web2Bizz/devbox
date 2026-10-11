import { createOpencodeClient } from '@opencode-ai/sdk/client';
import type { GlobalEventResponse } from '@opencode-ai/sdk/client';
import { api } from './client';

/**
 * OpenCode client for the browser — the SAME @opencode-ai/sdk (pinned
 * 1.18.33) as the backend, pointed at the backend reverse-proxy instead of
 * the opencode server directly:
 *
 *   baseUrl = <NEXT_PUBLIC_API_URL>/api/opencode  (opencodeProxyBaseUrl)
 *
 * Source: `api.baseUrl` from ./client — the literal
 * `process.env.NEXT_PUBLIC_API_URL` (verbatim for Next build inlining,
 * fallback `http://localhost:3000`, Dockerfile ARG NEXT_PUBLIC_API_URL
 * default `http://localhost:3000`, compose overrides via build arg).
 * The backend mirrors the upstream opencode OpenAPI 1:1 under
 * `/api/opencode/*` (see apps/backend/src/opencode/opencode.controller.ts),
 * so every typed sdk call (`session.list()`, `session.prompt()`,
 * `global.event()` SSE, …) flows browser → backend → opencode server with no
 * new contracts and no direct browser → OpenCode calls (no 4096/dialUrl in
 * the browser bundle — dialUrl lives server-side in OpencodeService only;
 * auth is server-side `Authorization: Bearer <OPENCODE_TOKEN>` only, never
 * logged, never shipped to the browser).
 *
 * Correlation: every sdk request carries a fresh `x-correlation-id`
 * (injected by `correlationFetch` below) which the backend echoes back
 * (CorrelationInterceptor + ApiErrorFilter) for log tracing.
 *
 * Error shape: the generated client defaults to `responseStyle: 'fields'`,
 * i.e. every call resolves `{ data, error, request, response }` — check
 * `error === undefined` before reading `data` (see `toErrorMessage`).
 * SSE (`global.event()`) resolves `{ stream: AsyncGenerator }` — cancel via
 * `AbortController.signal` in the call options + `stream.return()` on
 * unmount (see useOpencodeEvents).
 */
export const opencodeProxyBaseUrl = `${api.baseUrl}/api/opencode`;

/**
 * Fetch wrapper injecting a per-request `x-correlation-id` (skvozной with
 * the backend). Preserves an incoming header when the caller already set one
 * (e.g. tests); never logs or mutates anything else.
 */
function correlationFetch(request: Request): ReturnType<typeof fetch> {
  const headers = new Headers(request.headers);
  if (!headers.has('x-correlation-id')) {
    try {
      headers.set('x-correlation-id', crypto.randomUUID());
    } catch {
      /* crypto unavailable (non-secure context) — send without id; backend generates one */
    }
  }
  return fetch(new Request(request, { headers }));
}

export const opencode = createOpencodeClient({
  baseUrl: opencodeProxyBaseUrl,
  fetch: correlationFetch,
});

/** Re-exported stream frame type for rendering (session/message/file/… events). */
export type OpencodeEvent = GlobalEventResponse;

/**
 * Human-readable message for an sdk `{ data, error }` tuple failure or a
 * thrown transport error. Never surfaces secrets — the sdk error body carries
 * no credentials; only name/message/status are read.
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
