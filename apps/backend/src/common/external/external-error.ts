/**
 * ExternalServiceError — typed failure for outbound (upstream) calls.
 *
 * Carries a machine-readable `code` (EXTERNAL_*, GITHUB_AUTH), the logical
 * `service`/`operation`, the 1-based `attempt` that failed, the upstream
 * `status` when known, and `isRetryable` (429 / 5xx / timeout / network).
 * `httpStatus` is the HTTP status the api-error.filter answers with — the
 * `{ code, message, correlationId }` envelope shape is unchanged.
 *
 * Messages are fixed per code and never embed upstream bodies, URLs, tokens
 * or keys (never-log-secrets: only service/operation/attempt/status reach logs).
 */
export type ExternalErrorCode =
  | 'EXTERNAL_TIMEOUT'
  | 'EXTERNAL_UNAVAILABLE'
  | 'EXTERNAL_RATE_LIMITED'
  | 'EXTERNAL_UPSTREAM_5XX'
  | 'EXTERNAL_UNAUTHORIZED'
  | 'EXTERNAL_BAD_REQUEST'
  | 'EXTERNAL_NOT_FOUND'
  | 'GITHUB_AUTH';

export type ExternalErrorOptions = {
  code: ExternalErrorCode;
  /** Logical upstream, e.g. 'opencode' | 'github' | 'db'. */
  service: string;
  /** Logical operation, e.g. 'getSession' | 'listRepos' | 'checkDb'. */
  operation: string;
  /** Fixed human-readable message (no secrets, no upstream echo). */
  message: string;
  /** Upstream HTTP status when known. */
  status?: number;
  /** 1-based attempt number that produced this error. */
  attempt?: number;
  /** True for 429 / 5xx / timeout / network failures. */
  isRetryable?: boolean;
  /** Original cause (kept off the wire, never serialized to the envelope). */
  cause?: unknown;
};

const FIXED_MESSAGES: Record<ExternalErrorCode, string> = {
  EXTERNAL_TIMEOUT: 'Upstream request timed out',
  // Fixed 503 message for unreachable upstream (no secrets, no upstream echo).
  EXTERNAL_UNAVAILABLE: 'сервис временно недоступен, повторите позже',
  EXTERNAL_RATE_LIMITED: 'Upstream rate limit exceeded, retry later',
  EXTERNAL_UPSTREAM_5XX: 'Upstream service returned a server error',
  // Fixed 503 message for an upstream that refused OUR credentials (401/403).
  // Deliberately different from EXTERNAL_UNAVAILABLE: a retry with the same
  // credentials fails the same way, so the client must not read this as
  // "try again later". Service-neutral (the map is keyed by code, not by
  // service), no upstream echo, no secrets.
  EXTERNAL_UNAUTHORIZED: 'внутренняя авторизация в вышестоящем сервисе не пройдена',
  // Fixed messages for NON-RETRYABLE request-level 4xx from the upstream
  // (400/422 → rejected as invalid, 404 → not found). These are NOT
  // outages: masking them as 503 «сервис временно недоступен, повторите
  // позже» told the caller to retry a request that can only fail the same
  // way. Fixed per code, no upstream echo, no secrets.
  EXTERNAL_BAD_REQUEST: 'вышестоящий сервис отклонил запрос как некорректный',
  EXTERNAL_NOT_FOUND: 'ресурс не найден на вышестоящем сервисе',
  GITHUB_AUTH: 'GitHub authorization failed',
};

/** HTTP status the filter answers with for each code (upstream 5xx passes through when known). */
export function httpStatusFor(code: ExternalErrorCode, upstreamStatus?: number): number {
  switch (code) {
    case 'EXTERNAL_RATE_LIMITED':
      return 429;
    case 'EXTERNAL_TIMEOUT':
      return 504;
    case 'EXTERNAL_UPSTREAM_5XX':
      return upstreamStatus !== undefined &&
        Number.isInteger(upstreamStatus) &&
        upstreamStatus >= 500 &&
        upstreamStatus <= 599
        ? upstreamStatus
        : 502;
    case 'GITHUB_AUTH':
      return upstreamStatus === 401 || upstreamStatus === 403 ? upstreamStatus : 401;
    case 'EXTERNAL_UNAUTHORIZED':
      // 503, NOT 401: the frontend treats ANY 401 as "our session expired"
      // (refresh → logout, see useUsage / useProfile / useOpencodeSessions),
      // so a 401 here would kick the user out of the app. Our 401 means "the
      // upstream refused the credentials we sent" — a config defect on our
      // side, not the caller's session. 503 keeps it out of the refresh path.
      return 503;
    case 'EXTERNAL_BAD_REQUEST':
      // Honest 4xx passthrough (400 or 422): the upstream rejected THIS
      // request shape — neither an outage nor a caller-session problem, and
      // the filter never puts Retry-After on <500 answers.
      return upstreamStatus === 422 ? 422 : 400;
    case 'EXTERNAL_NOT_FOUND':
      // Honest 404: the upstream knows this resource is absent. Retry-After
      // would be a lie — repeating the same request finds the same 404.
      return 404;
    case 'EXTERNAL_UNAVAILABLE':
    default:
      return 503;
  }
}

export class ExternalServiceError extends Error {
  readonly code: ExternalErrorCode;
  readonly service: string;
  readonly operation: string;
  readonly status?: number;
  /** 1-based attempt that produced this error (restamped by the retry loop). */
  attempt: number;
  readonly isRetryable: boolean;
  readonly httpStatus: number;
  readonly cause?: unknown;

  constructor(opts: ExternalErrorOptions) {
    super(opts.message);
    this.name = 'ExternalServiceError';
    this.code = opts.code;
    this.service = opts.service;
    this.operation = opts.operation;
    this.attempt = opts.attempt ?? 1;
    this.status = opts.status;
    this.isRetryable = opts.isRetryable ?? defaultRetryable(opts.code);
    this.httpStatus = httpStatusFor(opts.code, opts.status);
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

function defaultRetryable(code: ExternalErrorCode): boolean {
  switch (code) {
    case 'EXTERNAL_TIMEOUT':
    case 'EXTERNAL_RATE_LIMITED':
    case 'EXTERNAL_UPSTREAM_5XX':
    case 'EXTERNAL_UNAVAILABLE':
      return true;
    case 'EXTERNAL_UNAUTHORIZED':
      // Refused credentials — the same request with the same credentials
      // fails the same way, so a retry is pointless.
      return false;
    case 'EXTERNAL_BAD_REQUEST':
    case 'EXTERNAL_NOT_FOUND':
      // Request-level 4xx: the same request can only fail the same way.
      return false;
    case 'GITHUB_AUTH':
      return false;
    default:
      return false;
  }
}

/** True for HTTP 429 or any 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * True for aborts / timeouts: AbortError name, EXTERNAL_TIMEOUT code, or
 * timeout-ish messages. Inspects shape only — never logs values.
 */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof ExternalServiceError) return err.code === 'EXTERNAL_TIMEOUT';
  if (typeof err !== 'object' || err === null) return false;
  const rec = err as Record<string, unknown>;
  if (rec['name'] === 'AbortError' || rec['code'] === 'AbortError') return true;
  const msg = typeof rec['message'] === 'string' ? (rec['message'] as string).toLowerCase() : '';
  return (
    msg.includes('aborted') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('exceeded the timeout')
  );
}

/** Fixed-message timeout error (no URL / no cause echo — cause stays off the wire). */
export function timeoutError(
  service: string,
  operation: string,
  attempt = 1,
  cause?: unknown,
): ExternalServiceError {
  return new ExternalServiceError({
    code: 'EXTERNAL_TIMEOUT',
    service,
    operation,
    message: FIXED_MESSAGES.EXTERNAL_TIMEOUT,
    attempt,
    isRetryable: true,
    cause,
  });
}

/**
 * Maps an upstream HTTP status to a fixed-code error.
 * 401/403 → GITHUB_AUTH for the github service, EXTERNAL_UNAUTHORIZED for
 * every other service (the upstream refused OUR credentials — the original
 * status is kept on the error, the http answer is 503 and never retryable);
 * 400/422 → EXTERNAL_BAD_REQUEST and 404 → EXTERNAL_NOT_FOUND (honest
 * non-retryable request-level 4xx passthrough — never masked as a 503
 * outage with Retry-After); 429 → EXTERNAL_RATE_LIMITED; 5xx →
 * EXTERNAL_UPSTREAM_5XX; anything else → EXTERNAL_UNAVAILABLE.
 */
export function fromStatus(
  service: string,
  operation: string,
  status: number,
  attempt = 1,
  cause?: unknown,
): ExternalServiceError {
  if (status === 429) {
    return new ExternalServiceError({
      code: 'EXTERNAL_RATE_LIMITED',
      service,
      operation,
      message: FIXED_MESSAGES.EXTERNAL_RATE_LIMITED,
      status,
      attempt,
      isRetryable: true,
      cause,
    });
  }
  if (status >= 500 && status <= 599) {
    return new ExternalServiceError({
      code: 'EXTERNAL_UPSTREAM_5XX',
      service,
      operation,
      message: FIXED_MESSAGES.EXTERNAL_UPSTREAM_5XX,
      status,
      attempt,
      isRetryable: true,
      cause,
    });
  }
  if ((status === 401 || status === 403) && service === 'github') {
    return new ExternalServiceError({
      code: 'GITHUB_AUTH',
      service,
      operation,
      message: FIXED_MESSAGES.GITHUB_AUTH,
      status,
      attempt,
      isRetryable: false,
      cause,
    });
  }
  if (status === 401 || status === 403) {
    // The upstream answered 401/403 — it refused the credentials we sent
    // (e.g. the opencode stand without a matching Basic password). NOT an
    // outage: the original status is kept for logs/monitoring, the http
    // answer is 503 EXTERNAL_UNAUTHORIZED (no Retry-After — a retry with
    // the same credentials cannot help).
    return new ExternalServiceError({
      code: 'EXTERNAL_UNAUTHORIZED',
      service,
      operation,
      message: FIXED_MESSAGES.EXTERNAL_UNAUTHORIZED,
      status,
      attempt,
      isRetryable: false,
      cause,
    });
  }
  if (status === 400 || status === 422) {
    // The upstream rejected THIS request shape (e.g. POST /api/session with
    // a missing/empty body → 400 `Expected object`). NOT an outage and NOT
    // retryable: the same request fails the same way, so masking it as the
    // 503 «повторите позже» would be a lie. Answered as an honest 4xx
    // (httpStatusFor) — the filter puts no Retry-After on <500 statuses.
    return new ExternalServiceError({
      code: 'EXTERNAL_BAD_REQUEST',
      service,
      operation,
      message: FIXED_MESSAGES.EXTERNAL_BAD_REQUEST,
      status,
      attempt,
      isRetryable: false,
      cause,
    });
  }
  if (status === 404) {
    // The upstream knows this resource is absent (e.g. a deleted session).
    // Honest 404 EXTERNAL_NOT_FOUND — not a 503 outage, no Retry-After.
    return new ExternalServiceError({
      code: 'EXTERNAL_NOT_FOUND',
      service,
      operation,
      message: FIXED_MESSAGES.EXTERNAL_NOT_FOUND,
      status,
      attempt,
      isRetryable: false,
      cause,
    });
  }
  return new ExternalServiceError({
    code: 'EXTERNAL_UNAVAILABLE',
    service,
    operation,
    message: FIXED_MESSAGES.EXTERNAL_UNAVAILABLE,
    status,
    attempt,
    isRetryable: false,
    cause,
  });
}

/**
 * Normalizes an unknown throw into an ExternalServiceError with a fixed
 * message. Timeout-shaped throws → EXTERNAL_TIMEOUT; ExternalServiceError
 * passes through; status-bearing throws (Octokit-style `{ status }`) go
 * through fromStatus(); everything else → EXTERNAL_UNAVAILABLE (retryable —
 * plain network failures such as ECONNREFUSED are worth one more attempt on
 * idempotent operations; the retry guard still limits non-idempotent ones
 * to a single attempt).
 */
export function fromUnknown(
  service: string,
  operation: string,
  err: unknown,
  attempt = 1,
): ExternalServiceError {
  if (err instanceof ExternalServiceError) return err;
  if (isTimeoutError(err)) return timeoutError(service, operation, attempt, err);
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return fromStatus(service, operation, status, attempt, err);
  }
  return new ExternalServiceError({
    code: 'EXTERNAL_UNAVAILABLE',
    service,
    operation,
    message: FIXED_MESSAGES.EXTERNAL_UNAVAILABLE,
    attempt,
    isRetryable: true,
    cause: err,
  });
}
