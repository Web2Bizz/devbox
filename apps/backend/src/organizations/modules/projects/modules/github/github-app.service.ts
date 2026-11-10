import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createAppAuth } from '@octokit/auth-app';
import { request as octokitRequest } from '@octokit/request';
import { AppLogger } from '@common/logger';
import { ExternalServiceError, fromUnknown } from '@common/external/external-error';
import { isGithubConfigured, validateEnv, type AppEnv } from '@common/env/env';

type CachedToken = {
  token: string;
  expiresAtMs: number;
};

/**
 * GitHub REST request with a fresh per-operation AbortSignal budget.
 * octokit@5 ignores `request.timeout`; the signal is what actually aborts a
 * hung call (→ EXTERNAL_TIMEOUT). Nested `request` defaults are deep-merged
 * by @octokit/request, so every downstream call (auth-app included) keeps it.
 */
function githubRequest(timeoutMs: number, baseUrl: string): typeof octokitRequest {
  return octokitRequest.defaults({
    baseUrl,
    request: { signal: AbortSignal.timeout(timeoutMs) },
  });
}

export type GithubAppInstallation = {
  id: number;
  account: { login: string; type: string } | null;
  createdAt: string | null;
};

/** Minimal subset of GET /app/installations/{id} consumed here. */
type InstallationApiResponse = {
  id?: number;
  account?: { login?: string; type?: string } | null;
  created_at?: string;
};

/** Refresh skew — never hand out a token expiring within the next minute. */
const EXPIRY_SKEW_MS: number = 60_000;

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
  private readonly cache: Map<number, CachedToken> = new Map<number, CachedToken>();

  constructor(private readonly logger: AppLogger = new AppLogger(GithubAppService.name)) {}

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
    const env: AppEnv = validateEnv(process.env);
    if (!isGithubConfigured(env)) {
      throw new UnauthorizedException('GitHub App is not configured');
    }
    const id: number =
      installationId ?? (env.githubInstallationId ? Number(env.githubInstallationId) : NaN);
    if (!Number.isInteger(id) || id <= 0) {
      throw new UnauthorizedException('GitHub App installation is missing');
    }

    const live: CachedToken | undefined = this.cache.get(id);
    if (live && live.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) return live.token;

    // Values stay local — never logged, never persisted.
    // Destructuring env secrets — explicit annotation cannot be expressed here.
    const { githubAppId: appId, githubPrivateKey: privateKey } = env;

    try {
      const request: typeof octokitRequest = githubRequest(
        env.githubRequestTimeoutMs,
        env.githubApiUrl,
      );
      const auth: ReturnType<typeof createAppAuth> = createAppAuth({
        appId: Number(appId),
        privateKey,
        // Respect GHE overrides — default stays https://api.github.com.
        // The request defaults also carry the per-operation abort signal.
        request,
      });
      // Destructuring the auth result — explicit annotation cannot be expressed here.
      const { token, expiresAt } = await auth({ type: 'installation', installationId: id });
      const expiresAtMs: number = Date.parse(expiresAt);
      this.cache.set(id, {
        token,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 50 * 60_000,
      });
      // Token mint is per-installation and frequent → debug (not info);
      // only the presence fact is logged, never the value.
      this.logger.debug('[github] installation token minted');
      return token;
    } catch (error) {
      this.cache.delete(id);
      throw this.toHttpError(error);
    }
  }

  /**
   * Looks up one installation through the GitHub App API
   * (GET /app/installations/{id}) using the App JWT — the callback needs
   * the account login to verify that the caller may bind this installation.
   * Returns only the id/account facts (no tokens leave this method).
   */
  async getInstallation(installationId: number): Promise<GithubAppInstallation> {
    const env: AppEnv = validateEnv(process.env);
    if (!isGithubConfigured(env)) {
      throw new UnauthorizedException('GitHub App is not configured');
    }
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new UnauthorizedException('GitHub App installation is missing');
    }

    // Destructuring env secrets — explicit annotation cannot be expressed here.
    const { githubAppId: appId, githubPrivateKey: privateKey } = env;

    try {
      const request: typeof octokitRequest = githubRequest(
        env.githubRequestTimeoutMs,
        env.githubApiUrl,
      );
      const auth: ReturnType<typeof createAppAuth> = createAppAuth({
        appId: Number(appId),
        privateKey,
        request,
      });
      // Destructuring the app-JWT result — explicit annotation cannot be expressed here.
      const { token } = await auth({ type: 'app' });
      const response: { data: unknown } = await request('GET /app/installations/{installation_id}', {
        headers: { authorization: `Bearer ${token}` },
        installation_id: installationId,
      });
      const data: InstallationApiResponse = response.data as InstallationApiResponse;
      return {
        id: typeof data.id === 'number' ? data.id : installationId,
        account:
          data.account && typeof data.account.login === 'string'
            ? {
                login: data.account.login,
                type:
                  typeof data.account.type === 'string' ? data.account.type : 'User',
              }
            : null,
        createdAt:
          typeof data.created_at === 'string' ? data.created_at : null,
      };
    } catch (error) {
      this.logger.warn('[github] app installation lookup failed');
      throw this.toHttpError(error);
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
    const id: number =
      installationId ??
      (process.env.GITHUB_APP_INSTALLATION_ID
        ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
        : 0);
    this.cache.set(id, { token, expiresAtMs });
  }

  private toHttpError(error: unknown): Error {
    const status: number =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status?: unknown }).status)
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
    const external: ExternalServiceError = fromUnknown('github', 'mintInstallationToken', error, 1);
    this.logger.warn(`[github] app auth transport failure code=${external.code}`);
    return external;
  }
}
