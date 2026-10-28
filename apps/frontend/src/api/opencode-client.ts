import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { api } from './client';
import { getAccessToken, getValidAccessToken } from '../lib/auth-store';

/**
 * OpenCode client for the browser — the SAME @opencode-ai/sdk (pinned
 * 1.18.33, `./v2/client` subpath) as the backend, pointed at the backend
 * reverse-proxy instead of the opencode server directly:
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
 * per-user opencode keys from the DB are server-side `Authorization: Bearer`
 * only, never logged, never shipped to the browser).
 * The BROWSER side authenticates as the user: `correlationFetch` attaches the
 * cached access token (`getAccessToken` from lib/auth-store, the same
 * `authorization: Bearer <accessToken>` header as every api/client call) —
 * never an opencode key. The token is read synchronously from the store
 * (memory → localStorage); when absent/expired the request goes out without
 * `Authorization` and the backend answers an honest 401 (no refresh attempt
 * here — `getValidAccessToken` is async and a refresh inside the sdk fetch
 * wrapper would add per-request latency; mutating callers refresh explicitly
 * via `ensureOpencodeAuth()` before create/abort/prompt, read-only
 * list/reload/SSE paths stay as-is — a 401 there is survived by the next
 * tick/retry).
 *
 * Correlation: every sdk request carries a fresh `x-correlation-id`
 * (injected by `correlationFetch` below) which the backend echoes back
 * (CorrelationInterceptor + ApiErrorFilter) for log tracing.
 *
 * Error shape: the generated client defaults to `responseStyle: 'fields'`,
 * i.e. every call resolves `{ data, error, request, response }` — check
 * `error === undefined` before reading `data` (see `toErrorMessage`).
 * SSE (`event.subscribe()` → `GET /event`, `v2.event.subscribe()` →
 * `GET /api/event`) resolves `{ stream: AsyncGenerator }` — cancel via
 * `AbortController.signal` in the call options + `stream.return()` on
 * unmount (see useOpencodeEvents).
 */
export const opencodeProxyBaseUrl = `${api.baseUrl}/api/opencode`;

/**
 * Thin wrapper over `getValidAccessToken` (lib/auth-store, single-flight
 * POST /auth/refresh): refreshes a stale/expired access into memory so the
 * sync `getAccessToken()` read inside `correlationFetch` picks up a fresh
 * token for the immediately following sdk call. The result is discarded —
 * only the side effect matters. No session → resolves null and the request
 * goes out without `Authorization` (honest 401, shown via `toErrorMessage`).
 * Mutating callers (`useOpencodeSessions.create/abort`, `useChat.send`)
 * `await` this first; read-only list/reload/SSE paths deliberately don't
 * (a 401 there is survived by the next tick/retry).
 */
export async function ensureOpencodeAuth(): Promise<void> {
  try {
    await getValidAccessToken();
  } catch {
    // No session / refresh failed — caller proceeds without a header.
  }
}

/**
 * C4 project scope for sdk calls through the backend reverse-proxy.
 *
 * Every `/api/opencode/session*` + `/config/providers` route requires
 * `?projectId` and gates it through
 * `OrganizationsService.assertProjectAccessById` BEFORE any upstream call
 * (missing → 400 PROJECT_REQUIRED, strangers → 404); the caller's
 * `?directory=` is accepted for compatibility but IGNORED server-side —
 * upstream always runs in the gated project's jailed content dir.
 *
 * Transport: the generated sdk (`buildClientParams`, no `allowExtra`)
 * silently DROPS unknown flat keys, so a plain `{ projectId }` would never
 * reach the URL. The hey-api `$query_` escape hatch is the supported path:
 * `{ $query_projectId }` lands verbatim as `?projectId=`, which Nest reads
 * via `@Query('projectId')`. Single source — every session/chat hook
 * spreads this instead of hand-rolling the key.
 *
 * Missing/empty projectId → `{}` (no query key): the backend answers an
 * honest 400 PROJECT_REQUIRED which the hook surfaces as error state —
 * never masked, never defaulted.
 */
export function projectScope(projectId?: string): { $query_projectId?: string } {
  return projectId ? { $query_projectId: projectId } : {};
}

/**
 * Fetch wrapper injecting a per-request `x-correlation-id` (skvozной with
 * the backend) plus the user's access token (`authorization: Bearer`, same
 * as every api/client call — reuse of the sync `getAccessToken` accessor
 * from lib/auth-store; no new auth logic, no opencode keys in the browser).
 * Preserves incoming headers when the caller already set them (e.g. tests);
 * never logs or mutates anything else. When the store holds no token the
 * request goes out without `Authorization` and the backend answers 401.
 *
 * Full fetch form `(input, init)` to satisfy the v2 `Config.fetch`
 * (`typeof fetch`): the sdk runtime always calls with a single `Request`
 * (see `createClient` in the generated client), so the normalization below
 * is type-level compat only — the hot path reuses the `Request` as-is.
 */
function correlationFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  const request =
    input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
  const headers = new Headers(request.headers);
  if (!headers.has('x-correlation-id')) {
    try {
      headers.set('x-correlation-id', crypto.randomUUID());
    } catch {
      /* crypto unavailable (non-secure context) — send without id; backend generates one */
    }
  }
  if (!headers.has('authorization')) {
    const accessToken = getAccessToken();
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  }
  return fetch(new Request(request, { headers }));
}

export const opencode = createOpencodeClient({
  baseUrl: opencodeProxyBaseUrl,
  // `as typeof fetch`: wrapper matches the call signature; the extra
  // `preconnect` member of the fetch type is N/A for a wrapper
  // (same cast pattern as apps/cli tests).
  fetch: correlationFetch as typeof fetch,
});

/** Re-exported stream frame type: native v2 `Event` union
 * (`{ id, type: 'session.*' | 'message.*' | …, properties: { sessionID, … } }`
 * — flat, no `payload` wrapper; see dist/v2/gen/types.gen.d.ts). */
export type OpencodeEvent = Event;

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
