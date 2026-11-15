import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Octokit } from 'octokit';
import { AppLogger } from '@common/logger';
import { validateEnv, type AppEnv } from '@common/env/env';
import {
  ExternalServiceError,
  fromUnknown,
} from '@common/external/external-error';
import { withRetry } from '@common/external/retry';
import { GithubAppService } from './github-app.service';
import {
  GithubInstallationsService,
  type GithubInstallation,
} from './github-installations.service';
import type { ListReposQueryInput } from './github.dto';

export type GithubRepo = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  url: string;
};

/**
 * E2e seam: stub fetch used by Octokit (no network in tests).
 * Production leaves it null → global fetch.
 */
let fetchImplForTests: typeof fetch | null = null;

/** Set a stub fetch for Octokit (compiled e2e); pass null to restore. */
export function __setGithubFetchForTests(
  fetchImplementation: typeof fetch | null,
): void {
  fetchImplForTests = fetchImplementation;
}

type InstallationReposResponse = {
  total_count?: number;
  repositories?: Array<{
    id?: number;
    name?: string;
    full_name?: string;
    private?: boolean;
    default_branch?: string | null;
    html_url?: string;
    owner?: { login?: string };
  }>;
};

/** One entry of GET /installation/repositories (derived from the payload type). */
type InstallationRepo = NonNullable<InstallationReposResponse['repositories']>[number];

/** Retry tuning consumed by `withRetry`. */
type RetryDefaults = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

/**
 * GithubService — lists repositories accessible to one GitHub App
 * installation via the official Octokit client.
 *
 * GET /installation/repositories (per_page/page) with the in-memory
 * per-installation token from GithubAppService; results are normalized to
 * { id, owner, name, fullName, private, defaultBranch, url }.
 * The GET is idempotent → bounded retry on 429/5xx/timeout/network
 * (EXTERNAL_RETRY_* tuning, per-attempt warn logs with attempt numbers).
 * Tokens are never logged or persisted.
 */
@Injectable()
export class GithubService {
  constructor(
    private readonly appAuth: GithubAppService,
    private readonly logger: AppLogger = new AppLogger(GithubService.name),
    private readonly installations: GithubInstallationsService,
  ) {}

  async listRepos(
    query: ListReposQueryInput,
    installationId: number,
    userId: string,
  ): Promise<Array<GithubRepo>> {
    const stored: GithubInstallation | null =
      await this.installations.findByInstallationId(installationId);
    if (stored === null || stored.userId === null || stored.userId !== userId) {
      throw new NotFoundException({
        code: 'GITHUB_NOT_INSTALLED',
        message: 'GitHub App is not installed for this user',
      });
    }
    const token: string = await this.appAuth.getInstallationToken(installationId);
    const env: AppEnv = validateEnv(process.env);
    // Destructuring the validated query — explicit annotation cannot be expressed here.
    const { page, per_page } = query;

    const octokit: Octokit = new Octokit({
      auth: token,
      baseUrl: env.githubApiUrl,
      ...(fetchImplForTests ? { request: { fetch: fetchImplForTests } } : {}),
    });

    let lastAttempt: number = 1;
    try {
      const response: { data: unknown } = await withRetry(
        async (attempt: number) => {
          lastAttempt = attempt;
          if (attempt > 1) {
            this.logger.warn(
              `[github] repos retry attempt=${attempt} installation=${installationId}`,
            );
          }
          return octokit.request('GET /installation/repositories', {
            per_page,
            page,
            // octokit@5 ignores `request.timeout` — the abort signal is the
            // actual per-attempt budget (hung GitHub → EXTERNAL_TIMEOUT).
            request: {
              signal: AbortSignal.timeout(env.githubRequestTimeoutMs),
            },
          });
        },
        { method: 'GET', ...this.retryDefaults() },
      );
      const data: InstallationReposResponse = response.data as InstallationReposResponse;
      const repos: Array<InstallationRepo> = Array.isArray(data.repositories)
        ? data.repositories
        : [];
      // Per-request listing on a hot path → debug (not info).
      this.logger.debug('[github] repos listed');
      return repos.map((repo) => this.normalize(repo));
    } catch (error) {
      throw this.toHttpError(error, lastAttempt);
    }
  }

  /** EXTERNAL_RETRY_* tuning (silent env defaults, fail-open to 3/200/2000). */
  private retryDefaults(): RetryDefaults {
    try {
      const env: AppEnv = validateEnv(process.env);
      return {
        maxAttempts: env.externalRetryMaxAttempts,
        baseDelayMs: env.externalRetryBaseDelayMs,
        maxDelayMs: env.externalRetryMaxDelayMs,
      };
    } catch {
      return { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 };
    }
  }

  private normalize(repo: InstallationRepo): GithubRepo {
    const fullName: string = typeof repo.full_name === 'string' ? repo.full_name : '';
    // Array destructuring of the first path segment — explicit annotation cannot be expressed here.
    const [ownerFromFull] = fullName.split('/');
    const owner: string = repo.owner?.login ?? ownerFromFull ?? '';
    const name: string = repo.name ?? fullName.split('/')[1] ?? '';
    return {
      id: typeof repo.id === 'number' ? repo.id : 0,
      owner,
      name,
      fullName,
      private: Boolean(repo.private),
      defaultBranch: repo.default_branch ?? 'main',
      url:
        repo.html_url ??
        (owner && name ? `https://github.com/${owner}/${name}` : ''),
    };
  }

  /**
   * Auth-shaped failures (401/403/404) keep the historical Nest HTTP errors
   * (e2e-compat: `unauthorized` / `forbidden` / `not_found` envelopes);
   * retryable transport failures (429/5xx/timeout/network, possibly after
   * retries) surface as ExternalServiceError with EXTERNAL_* codes and the
   * final attempt number (api-error.filter keeps the same envelope shape).
   */
  private toHttpError(error: unknown, attempt: number = 1): Error {
    const status: number =
      error instanceof ExternalServiceError && error.status !== undefined
        ? error.status
        : typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status?: unknown }).status)
          : NaN;
    // Fixed messages + status in logs only; upstream bodies may embed
    // ids/urls but never our key/token (we never log error content).
    if (status === 401) {
      this.logger.warn('[github] repos unauthorized (401)');
      return new UnauthorizedException('GitHub authorization failed');
    }
    if (status === 403) {
      this.logger.warn('[github] repos forbidden (403)');
      return new ForbiddenException('GitHub App lacks repository access');
    }
    if (status === 404) {
      this.logger.warn('[github] repos not found (404)');
      return new NotFoundException('GitHub installation not found');
    }
    const external: ExternalServiceError = fromUnknown('github', 'listRepos', error, attempt);
    this.logger.warn(
      `[github] repos transport failure code=${external.code} attempt=${external.attempt}`,
    );
    // Retryable transport failures (429/5xx/timeout/network, possibly after
    // retries) surface typed: api-error.filter maps them to 429/503/504 with
    // the same { code, message, correlationId } envelope.
    return external;
  }
}
