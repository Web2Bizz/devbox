import type {
  AcceptInviteInput as AcceptInviteRequest,
  AddMemberInput as AddMemberRequest,
  ApiError,
  AuthSession,
  AuthTokens,
  AuthUser,
  CreateInviteInput as CreateInviteRequest,
  CreateOrganizationInput as CreateOrganizationRequest,
  CreateProjectInput as CreateProjectRequest,
  HealthResponse,
  Organization as OrganizationDto,
  OrganizationInvite as InviteDto,
  OrganizationMember as MemberDto,
  MessagesResponse,
  NpmRegistryStatusResponse,
  OpencodeKeyResult,
  OpencodeKeyStatus,
  OpencodeUsage,
  OrgRole,
  Project as ProjectApiDto,
  RegistryCatalogResponse,
  SendChatResponse,
  Session,
  UpdateMemberRoleInput as UpdateMemberRoleRequest,
  UpdateOrganizationInput as UpdateOrganizationRequest,
} from '@devbox/contracts';

// Base URL resolution (Next.js App Router):
// - process.env.NEXT_PUBLIC_API_URL is inlined at `next build` time. The literal
//   `process.env.NEXT_PUBLIC_API_URL` below must stay verbatim so the Next
//   compiler can inline it (no indirection via helpers/globals).
// - Single source is the repo-root `.env.example`: NEXT_PUBLIC_API_URL=${APP_BACKEND_SOCKET},
//   where APP_BACKEND_SOCKET=${APP_BACKEND_PROTOCOL}://${APP_BACKEND_HOST}:${APP_BACKEND_PORT}.
// - Fallback mirrors the composed dev default (APP_BACKEND_SOCKET=http://localhost:3000).
//   readonly-исключение: браузерный read-конфиг, инлайнится в бандл на `next build`
//   (литерал process.env.NEXT_PUBLIC_API_URL обязан остаться verbatim); дефолт лишь
//   для локального dev — прод перекрывается Dockerfile ARG/compose build arg.
//   Промах диалога не маскируется под успех: неуспех сети кидает ApiClientError
//   (network_error/timeout с correlationId), моки/200-фолбэки запрещены.
// - No import.meta.env / VITE_* here: the browser bundle must not depend on Vite.
const BASE_URL =
  (typeof process !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_URL as string | undefined)
    : undefined
  )?.replace(/\/$/, '') || 'http://localhost:3000';

// API versioning: canonical prefix is /api/v1 (backend URI versioning).
// Unversioned /api/* aliases were removed on the backend (now 404) —
// no fallback, the client always talks /api/v1 (+ /health unversioned).
export const API_VERSION = 'v1';
const V1_PREFIX = `/api/${API_VERSION}`;

const DEFAULT_TIMEOUT_MS = 10_000;

export class ApiClientError extends Error {
  code: string;
  status: number;
  correlationId: string;
  constructor(args: { code: string; message: string; status: number; correlationId: string }) {
    super(args.message);
    this.name = 'ApiClientError';
    this.code = args.code;
    this.status = args.status;
    this.correlationId = args.correlationId;
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const externalSignal = init.signal as AbortSignal | null | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const correlationId = crypto.randomUUID();
  const onExternalAbort = () => {
    try {
      ctrl.abort((externalSignal as AbortSignal).reason);
    } catch {
      ctrl.abort();
    }
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      const reason = (externalSignal as AbortSignal).reason;
      throw reason instanceof Error
        ? reason
        : new DOMException('The operation was aborted.', 'AbortError');
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const { signal: _externalIgnored, ...restInit } = init;
    void _externalIgnored;
    const res = await fetch(`${BASE_URL}${path}`, {
      ...restInit,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
        ...(init.headers ?? {}),
      },
    });
    const data = (await res.json().catch(() => null)) as T | (ApiError & { error?: string }) | null;
    if (!res.ok) {
      const err = (data ?? {}) as Partial<ApiError>;
      // Prefer the backend envelope correlationId; fall back to the
      // x-correlation-id response header (empty body / proxy edge), then to
      // the client-generated request id so the UI always has a traceable ID.
      const headerId = res.headers.get('x-correlation-id');
      throw new ApiClientError({
        code: err.code ?? `http_${res.status}`,
        message: err.message ?? `HTTP ${res.status}`,
        status: res.status,
        correlationId: err.correlationId ?? headerId ?? correlationId,
      });
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiClientError) throw e;
    if ((e as Error).name === 'AbortError') {
      // React Query cancellation (queryFn signal) must stay an AbortError so
      // the cancelled query does not surface as a timeout error in the UI.
      if (externalSignal?.aborted) throw e;
      throw new ApiClientError({
        code: 'timeout',
        message: `Request timed out after ${timeoutMs}ms`,
        status: 0,
        correlationId,
      });
    }
    throw new ApiClientError({
      code: 'network_error',
      message: (e as Error).message,
      status: 0,
      correlationId,
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Versioned request: always /api/v1/* (+ /health unversioned).
 * No legacy /api/* fallback — the backend removed those aliases (404).
 */
async function requestV1<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return request<T>(`${V1_PREFIX}${path}`, init, timeoutMs);
}

export const api = {
  baseUrl: BASE_URL,
  apiVersion: API_VERSION,
  getHealth: () => request<HealthResponse>('/health'),
  // Proxy routes: 200 always means live upstream data. When the opencode
  // server is unreachable the backend answers 503 EXTERNAL_UNAVAILABLE
  // («сервис временно недоступен, повторите позже») with Retry-After —
  // surfaced here as ApiClientError (no mock payloads, never 200).
  getSession: () => requestV1<Session>('/session'),
  getMessages: (sessionId: string) =>
    requestV1<MessagesResponse>(`/messages?sessionId=${encodeURIComponent(sessionId)}`),
  sendChat: (message: string, sessionId?: string) =>
    requestV1<SendChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify({ message, sessionId }),
    }),
  // Docker-registry surface: 200 always means live upstream /v2/_catalog
  // data. Unconfigured/unreachable answers 503 EXTERNAL_UNAVAILABLE
  // («сервис временно недоступен, повторите позже») with Retry-After —
  // surfaced here as ApiClientError (no mock payloads, never 200).
  // No token: catalog is public reachability, auth lives server-side.
  // Optional `signal` forwards React Query cancellation (queryFn signal)
  // into the timeout controller — no local AbortController in hooks.
  getRegistryCatalog: (opts?: { signal?: AbortSignal }) =>
    requestV1<RegistryCatalogResponse>(
      '/registry/catalog',
      opts?.signal ? { signal: opts.signal } : {},
    ),
  // npm surface: 200 always means live Verdaccio /-/ping reachability
  // ({ status: 'up', url, scope }); unconfigured/unreachable answers 503
  // EXTERNAL_UNAVAILABLE («сервис временно недоступен, повторите позже»)
  // with Retry-After — surfaced here as ApiClientError (no mock payloads,
  // token never in payload).
  // Optional `signal` forwards React Query cancellation (queryFn signal).
  getNpmStatus: (opts?: { signal?: AbortSignal }) =>
    requestV1<NpmRegistryStatusResponse>(
      '/registry/npm/status',
      opts?.signal ? { signal: opts.signal } : {},
    ),
  // Auth surface (internal accounts): register/login issue the access +
  // rotating refresh pair; refresh/logout carry `credentials: 'include'` so
  // the httpOnly `devbox-refresh` cookie travels cross-origin (frontend
  // :3001 → backend). 401 codes are `invalid_credentials` (generic, no
  // enumeration) and `email_taken` (409) — surfaced as ApiClientError.
  // register/login also carry `credentials: 'include'` so the Set-Cookie
  // pair (devbox-refresh + devbox-auth) is stored on cross-origin dev.
  register: (input: { firstName: string; lastName: string; email: string; password: string }) =>
    requestV1<AuthSession>('/auth/register', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(input),
    }),
  login: (input: { email: string; password: string }) =>
    requestV1<AuthSession>('/auth/login', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(input),
    }),
  refresh: (input: { refreshToken: string }) =>
    requestV1<AuthTokens>('/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(input),
    }),
  logout: (refreshToken?: string) =>
    requestV1<{ ok: boolean }>('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    }),
  me: (accessToken: string) =>
    requestV1<AuthUser>('/auth/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  updateMe: (accessToken: string, patch: { firstName?: string; lastName?: string }) =>
    requestV1<AuthUser>('/auth/me', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(patch),
    }),
  // Projects surface — strict Postgres-backed, 503 when unavailable.
  // No mock fallback here: client always talks /api/v1/projects.
  listProjects: () => requestV1<ProjectApiDto[]>('/projects'),
  createProject: (input: CreateProjectRequest) =>
    requestV1<ProjectApiDto>('/projects', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(input),
    }),
  getProject: (id: string) => requestV1<ProjectApiDto>(`/projects/${encodeURIComponent(id)}`),
  // Organizations surface (contracts/openapi.yaml, additive verbatim).
  // Bearer via Authorization header; invite tokens travel request bodies
  // only and are NEVER logged (no console.* of token material anywhere).
  // All failures surface as ApiClientError (no fallbacks).
  listOrganizations: (accessToken: string) =>
    requestV1<OrganizationDto[]>('/organizations', {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  createOrganization: (accessToken: string, input: CreateOrganizationRequest) =>
    requestV1<OrganizationDto>('/organizations', {
      method: 'POST',
      credentials: 'include',
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(input),
    }),
  getOrganization: (accessToken: string, id: string) =>
    requestV1<OrganizationDto>(`/organizations/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  updateOrganization: (accessToken: string, id: string, patch: UpdateOrganizationRequest) =>
    requestV1<OrganizationDto>(`/organizations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(patch),
    }),
  deleteOrganization: (accessToken: string, id: string) =>
    requestV1<void>(`/organizations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  listOrgMembers: (accessToken: string, id: string) =>
    requestV1<MemberDto[]>(`/organizations/${encodeURIComponent(id)}/members`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  addOrgMember: (accessToken: string, id: string, input: AddMemberRequest) =>
    requestV1<MemberDto>(`/organizations/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      credentials: 'include',
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(input),
    }),
  changeOrgMemberRole: (
    accessToken: string,
    id: string,
    userId: string,
    input: UpdateMemberRoleRequest,
  ) =>
    requestV1<MemberDto>(
      `/organizations/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(input),
      },
    ),
  removeOrgMember: (accessToken: string, id: string, userId: string) =>
    requestV1<void>(
      `/organizations/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        credentials: 'include',
        headers: { authorization: `Bearer ${accessToken}` },
      },
    ),
  createOrgInvite: (accessToken: string, id: string, input: CreateInviteRequest = {}) =>
    requestV1<InviteDto>(`/organizations/${encodeURIComponent(id)}/invites`, {
      method: 'POST',
      credentials: 'include',
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(input),
    }),
  acceptOrgInvite: (accessToken: string, input: AcceptInviteRequest) =>
    requestV1<MemberDto>('/organizations/invites/accept', {
      method: 'POST',
      credentials: 'include',
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(input),
    }),
  linkOrgProject: (accessToken: string, id: string, projectId: string) =>
    requestV1<void>(
      `/organizations/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { authorization: `Bearer ${accessToken}` },
      },
    ),
  unlinkOrgProject: (accessToken: string, id: string, projectId: string) =>
    requestV1<void>(
      `/organizations/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'DELETE',
        credentials: 'include',
        headers: { authorization: `Bearer ${accessToken}` },
      },
    ),
  // GET /users/:id — own profile only ( чужой → 403 before any DB lookup,
  // private — never indexed). Surfaced as ApiClientError, no fallbacks.
  getUser: (accessToken: string, id: string) =>
    requestV1<AuthUser>(`/users/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  // GET /api/v1/usage — live Zen Go usage (+ optional legacy balance/usage,
  // additive rolling/daily/weekly/monthly breakdown; Zen percent is exposed
  // as { used: percent, limit: 100 }). Missing key → 404
  // opencode_key_missing (hook maps it to the no-key empty state, not 0% bars).
  getUsage: (accessToken: string) =>
    requestV1<OpencodeUsage>('/usage', {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  // Per-user OpenCode key — PUT /api/v1/key { apiKey } (zod min 20, max
  // 1024, encrypted AES-256-GCM at rest, never echoed/logged),
  // GET /api/v1/key (existence only { configured, updatedAt? }).
  putKey: (accessToken: string, input: { apiKey: string }) =>
    requestV1<OpencodeKeyResult>('/key', {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(input),
    }),
  getKeyStatus: (accessToken: string) =>
    requestV1<OpencodeKeyStatus>('/key', {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
};
