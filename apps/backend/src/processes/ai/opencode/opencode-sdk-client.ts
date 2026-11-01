import { Injectable } from '@nestjs/common';
// NOTE: type-only import — the sdk is ESM-only (exports map has no
// `require` condition) while the backend compiles to CJS, so values are
// loaded via dynamic `import()` in `loadSdk()` below (works under bun and
// node 22+, and survives the CJS build thanks to `module.ignoreDynamic`
// in `.swcrc`). Never add a value import here or dist/* breaks at boot.
// v2 entry-point is the `./v2` subpath of the pinned 1.18.33 package
// (dist/v2 + dist/v2/gen on disk); there is no 2.x major.
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { OpencodeService } from './opencode.service';
import { AppLogger } from '../../../common/logger';
import { ExternalClient } from '../../../common/external/external-client';
import { ServeAuthService, serveBasicAuthHeader } from './modules/auth/auth.service';

type SdkModule = typeof import('@opencode-ai/sdk/v2');

let sdkPromise: Promise<SdkModule> | null = null;

/** Cached dynamic import of the ESM-only sdk. `.swcrc` sets `ignoreDynamic`
 * so SWC keeps `import()` intact in the CJS output — a literal `import()` here
 * is the supported path, not a `require()` shim. */
const nativeImport = (): Promise<SdkModule> => import('@opencode-ai/sdk/v2');

/** Cached dynamic import of the ESM-only sdk (CJS-safe). */
function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= nativeImport();
  return sdkPromise;
}

/**
 * OpencodeSdkClient — single owner of the @opencode-ai/sdk (pinned 1.18.33,
 * `./v2` subpath) instance.
 *
 * - `baseUrl` is always `OpencodeService.dialUrl()` (explicit 0.0.0.0 is
 *   preserved in config but undialable — dial 127.0.0.1 instead). The v2
 *   client multiplexes the `/…` legacy paths AND the `/api/…` v2 namespace
 *   against the server root, so no `/api` suffix is appended here — that
 *   would double-prefix `/api/*` into `/api/api/*` (see dist/v2/gen/sdk.gen.js
 *   `url:` fields: `/session`, `/event`, `/global/event` alongside
 *   `/api/session`, `/api/event`, `/api/health` — that last one is an sdk
 *   surface inventory only: the 2.x server does NOT serve `/api/health`
 *   (404); our liveness is `GET /api/info` — see
 *   `OpencodeService.checkConnectivity`).
 * - Auth is the SERVER password: `Authorization: Basic
 *   base64("opencode:<OPENCODE_PASSWORD>")` from env (v2 canonical,
 *   username `opencode`). No per-user DB Bearer on this path — the stand
 *   always runs password-protected and rejects user-key Bearers with 401.
 *   ServeAuthService stays only as the real-user gate (non-uuid mock
 *   identities → 401 before any upstream call). Without OPENCODE_PASSWORD
 *   no header is sent at all and the upstream 401 is the honest signal.
 *   The value is never logged, only `auth=yes|no` + `scheme=basic` presence
 *   is traced at debug.
 * - Transport goes through ExternalClient (`service='opencode-sdk'`) so every
 *   sdk call reuses REQUEST_TIMEOUT_MS + EXTERNAL_RETRY_* tuning and uniform
 *   attempt logging (no URLs/headers/bodies in logs, secrets never logged).
 * - The sdk speaks the upstream opencode OpenAPI directly
 *   (legacy `GET /session`, `POST /session/{sessionID}/message`,
 *   `GET /global/event` SSE plus the v2 namespace `GET /api/session`,
 *   `POST /session/{sessionID}/prompt_async`, `GET /api/event` SSE, and the
 *   sdk's `GET /api/health` binding — which the 2.x server does not serve;
 *   it is NOT our health path, liveness goes through `GET /api/info`.
 *   Path params use `sessionID` with a capital D);
 *   `OpencodeController` mirrors those paths under `/api/opencode/*` so the
 *   frontend can use the SAME sdk against the backend base URL with no new
 *   contracts.
 */
@Injectable()
export class OpencodeSdkClient {
  constructor(
    private readonly opencode: OpencodeService,
    private readonly external: ExternalClient,
    private readonly auth: ServeAuthService,
    private readonly logger: AppLogger = new AppLogger('OpencodeSdkClient'),
  ) {}

  /**
   * Fetch implementation injected into the generated sdk client. Adapts the
   * sdk's `Request`-style fetch to ExternalClient (timeout + bounded retry +
   * logging). Non-idempotent methods run once (same guard as the domain prompt);
   * GET/HEAD reuse the idempotent retry budget.
   *
   * Full fetch form `(input, init)` to satisfy the v2 `Config.fetch`
   * (`typeof fetch`): the sdk runtime always calls with a single `Request`
   * (see `createClient` in the generated client), so the normalization below
   * is type-level compat only — the hot path reuses the `Request` as-is.
   */
  private sdkFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const req =
      input instanceof Request && init === undefined
        ? input
        : new Request(input, init);
    const method = req.method.toUpperCase();
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'host') return;
      headers[key] = value;
    });
    const forwardInit: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      forwardInit.body = await req.arrayBuffer();
      (forwardInit as Record<string, unknown>).duplex = 'half';
    }
    return this.external.fetchWithRetry(req.url, forwardInit, {
      service: 'opencode-sdk',
      operation: 'sdk',
      timeoutMs: this.opencode.timeoutMs,
      allowNonIdempotentRetry: false,
    });
  };

  /**
   * Fresh sdk client per call-site (carries per-request correlation id).
   *
   * `userId` is the authenticated caller (from @ReqUser(), JwtAuthGuard above
   * us); the real-user gate (non-uuid mock → 401) runs here before any
   * upstream traffic. Upstream auth is the server Basic password from env —
   * never a per-user DB key, never logged, never persisted. Unset password
   * → no header (upstream 401 is the honest signal, never masked).
   */
  async create(userId: string, correlationId?: string): Promise<OpencodeClient> {
    const { createOpencodeClient } = await loadSdk();
    this.auth.assertServeUser(userId, correlationId);
    const headers: Record<string, string> = { ...serveBasicAuthHeader() };
    if (correlationId) headers['x-correlation-id'] = correlationId;
    this.logger.debug(
      `[opencode-sdk] client base=dialUrl auth=${'authorization' in headers ? 'yes' : 'no'} scheme=basic`,
      correlationId,
    );
    return createOpencodeClient({
      baseUrl: this.opencode.dialUrl(),
      headers,
      // `as typeof fetch`: wrapper matches the call signature; the extra
      // `preconnect` member of the undici fetch type is N/A for a wrapper
      // (same cast pattern as github.e2e.ts / apps/cli tests).
      fetch: this.sdkFetch as typeof fetch,
    });
  }
}
