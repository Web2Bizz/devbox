import { Injectable } from '@nestjs/common';
// NOTE: type-only import — the sdk is ESM-only (exports map has no
// `require` condition) while the backend compiles to CJS, so values are
// loaded via dynamic `import()` in `loadSdk()` below (works under bun and
// node 22+, and survives the CJS build thanks to `module.ignoreDynamic`
// in `.swcrc`). Never add a value import here or dist/* breaks at boot.
import type { OpencodeClient } from '@opencode-ai/sdk';
import { OpencodeService } from './opencode.service';
import { AppLogger } from '../common/app-logger.service';
import { ExternalClient } from '../common/external/external-client';
import { validateEnv } from '../env';

type SdkModule = typeof import('@opencode-ai/sdk');

let sdkPromise: Promise<SdkModule> | null = null;

/** Cached dynamic import of the ESM-only sdk. `.swcrc` sets `ignoreDynamic`
 * so SWC keeps `import()` intact in the CJS output — a literal `import()` here
 * is the supported path, not a `require()` shim. */
const nativeImport = (): Promise<SdkModule> => import('@opencode-ai/sdk');

/** Cached dynamic import of the ESM-only sdk (CJS-safe). */
function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= nativeImport();
  return sdkPromise;
}

/**
 * OpencodeSdkClient — single owner of the @opencode-ai/sdk (pinned 1.18.33)
 * instance.
 *
 * - `baseUrl` is always `OpencodeService.dialUrl()` (explicit 0.0.0.0 is
 *   preserved in config but undialable — dial 127.0.0.1 instead).
 * - Auth is an optional `Authorization: Bearer <OPENCODE_TOKEN>` default
 *   header ('' = unauthenticated; the value is never logged — only its
 *   presence is traced at debug as `auth=yes|no`).
 * - Transport goes through ExternalClient (`service='opencode-sdk'`) so every
 *   sdk call reuses REQUEST_TIMEOUT_MS + EXTERNAL_RETRY_* tuning and uniform
 *   attempt logging (no URLs/headers/bodies in logs, secrets never logged).
 * - The sdk speaks the upstream opencode OpenAPI directly
 *   (GET /session, POST /session/{id}/message, GET /global/event SSE, …);
 *   `OpencodeController` mirrors those paths under `/api/opencode/*` so the
 *   frontend can use the SAME sdk against the backend base URL with no new
 *   contracts.
 */
@Injectable()
export class OpencodeSdkClient {
  constructor(
    private readonly opencode: OpencodeService,
    private readonly external: ExternalClient,
    private readonly logger: AppLogger = new AppLogger('OpencodeSdkClient'),
  ) {}

  private token(): string {
    try {
      return validateEnv(process.env).opencodeToken;
    } catch {
      return '';
    }
  }

  /**
   * Fetch implementation injected into the generated sdk client. Adapts the
   * sdk's `Request`-style fetch to ExternalClient (timeout + bounded retry +
   * logging). Non-idempotent methods run once (same guard as ProxyService);
   * GET/HEAD reuse the idempotent retry budget.
   */
  private sdkFetch = async (req: Request): Promise<Response> => {
    const method = req.method.toUpperCase();
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'host') return;
      headers[key] = value;
    });
    const init: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = await req.arrayBuffer();
      (init as Record<string, unknown>).duplex = 'half';
    }
    return this.external.fetchWithRetry(req.url, init, {
      service: 'opencode-sdk',
      operation: 'sdk',
      timeoutMs: this.opencode.timeoutMs,
      allowNonIdempotentRetry: false,
    });
  };

  /** Fresh sdk client per call-site (carries per-request correlation id). */
  async create(correlationId?: string): Promise<OpencodeClient> {
    const { createOpencodeClient } = await loadSdk();
    const headers: Record<string, string> = {};
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (correlationId) headers['x-correlation-id'] = correlationId;
    this.logger.debug(
      `[opencode-sdk] client base=dialUrl auth=${token ? 'yes' : 'no'}`,
      correlationId,
    );
    return createOpencodeClient({
      baseUrl: this.opencode.dialUrl(),
      headers,
      fetch: this.sdkFetch,
    });
  }
}
