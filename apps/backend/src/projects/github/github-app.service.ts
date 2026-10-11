import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createAppAuth } from '@octokit/auth-app';
import { request as octokitRequest } from '@octokit/request';
import { AppLogger } from '../../common/app-logger.service.js';
import { fromUnknown } from '../../common/external/external-error.js';
import { isGithubConfigured, validateEnv } from '../../env.js';

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Refresh skew — never hand out a token expiring within the next minute. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * GithubAppService — mints GitHub App installation tokens (multi-tenant).
 *
 * Flow: sign App JWT (via @octokit/auth-app, official) →
 * POST /app/installations/{installation_id}/access_tokens →
 * short-lived installation token cached IN MEMORY per installation id
 * until expires_at.
 *
 * The token mint is a POST → exactly ONE attempt (non-idempotent guard;
 * no retry even on 429/5xx) — a slow GitHub surfaces as EXTERNAL_TIMEOUT /
 * EXTERNAL_UPSTREAM_5XX via api-error.filter with the same envelope.
 * Auth-shaped failures (401/403/404) keep the historical Nest HTTP errors.
 *
 * - APP_ID + PRIVATE_KEY are global (env); the installation id is passed
 *   per call (resolved from the current user's stored installation, with a
 *   legacy GITHUB_APP_INSTALLATION_ID dev fallback when omitted).
 * - Secrets (app id / private key / tokens) come only from env and are
 *   never logged (AppLogger sanitizes + this service never passes values).
 * - No token persistence: module-private Map only, entries cleared on expiry.
 * - GitHub 401/403/404 map to Nest HTTP errors without leaking the key.
 */
@Injectable()
export class GithubAppService {
  private readonly cache = new Map<number, CachedToken>();

  constructor(private readonly logger: AppLogger = new AppLogger('GithubAppService')) {}

  /** False when the GITHUB_APP_* pair is absent — repos endpoint answers 401. */
  isConfigured(): boolean {
    try {
      return isGithubConfigured(validateEnv(process.env));
    } catch {
      return false;
    }
  }

  /**
   * Returns a live token for the given installation (cached until
   * expires_at minus skew). When installationId is omitted, the legacy
   * GITHUB_APP_INSTALLATION_ID dev fallback is used.
   * Throws Unauthorized when unconfigured / id missing, NotFound/Forbidden
   * on bad installation/permissions, ServiceUnavailable on transport failures.
   */
  async getInstallationToken(installationId?: number): Promise<string> {
    const env = validateEnv(process.env);
    if (!isGithubConfigured(env)) {
      throw new UnauthorizedException('GitHub App is not configured');
    }
    const id =
      installationId ?? (env.githubInstallationId ? Number(env.githubInstallationId) : NaN);
    if (!Number.isInteger(id) || id <= 0) {
      throw new UnauthorizedException('GitHub App installation is missing');
    }

    const live = this.cache.get(id);
    if (live && live.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) return live.token;

    // Values stay local — never logged, never persisted.
    const { githubAppId: appId, githubPrivateKey: privateKey } = env;

    try {
      const auth = createAppAuth({
        appId: Number(appId),
        privateKey,
        // Respect GHE overrides — default stays https://api.github.com.
        request: octokitRequest.defaults({ baseUrl: env.githubApiUrl }),
      });
      const { token, expiresAt } = await auth({ type: 'installation', installationId: id });
      const expiresAtMs = Date.parse(expiresAt);
      this.cache.set(id, {
        token,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 50 * 60_000,
      });
      // Token mint is per-installation and frequent → debug (not info);
      // only the presence fact is logged, never the value.
      this.logger.debug('[github] installation token minted');
      return token;
    } catch (err) {
      this.cache.delete(id);
      throw this.toHttpError(err);
    }
  }

  /** Drops cached token(s) — all when installationId is omitted (logout/rotation/tests). */
  clearCache(installationId?: number): void {
    if (installationId === undefined) this.cache.clear();
    else this.cache.delete(installationId);
  }

  /**
   * Test seam for the compiled e2e (no network): pre-seeds a cached token
   * for one installation (or the legacy fallback id when omitted) so
   * listRepos runs without contacting GitHub's token endpoint.
   */
  __setCachedTokenForTests(token: string, expiresAtMs: number, installationId?: number): void {
    const id =
      installationId ??
      (process.env.GITHUB_APP_INSTALLATION_ID
        ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
        : 0);
    this.cache.set(id, { token, expiresAtMs });
  }

  private toHttpError(err: unknown): Error {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? Number((err as { status?: unknown }).status)
        : NaN;
    // Status only — message may embed ids, never the key/token (AppLogger
    // redacts secret keys anyway; we keep logs to fixed prefixes + status).
    if (status === 401) {
      this.logger.warn('[github] app auth failed (401)');
      return new UnauthorizedException('GitHub App authentication failed');
    }
    if (status === 403) {
      this.logger.warn('[github] app auth forbidden (403)');
      return new ForbiddenException('GitHub App installation is forbidden');
    }
    if (status === 404) {
      this.logger.warn('[github] app installation not found (404)');
      return new NotFoundException('GitHub App installation not found');
    }
    // Transport failures (429/5xx/timeout/network) surface typed with fixed
    // messages; api-error.filter maps them (same envelope, 429/503/504).
    const external = fromUnknown('github', 'mintInstallationToken', err, 1);
    this.logger.warn(`[github] app auth transport failure code=${external.code}`);
    return external;
  }
}
