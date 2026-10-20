import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Octokit } from 'octokit';
import { AppLogger } from '../../common/app-logger.service';
import { validateEnv } from '../../env';
import {
  ExternalServiceError,
  fromUnknown,
} from '../../common/external/external-error';
import { withRetry } from '../../common/external/retry';
import { GithubAppService } from './github-app.service';
import type { ListReposQueryInput } from './dto';

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
export function __setGithubFetchForTests(fn: typeof fetch | null): void {
  fetchImplForTests = fn;
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
    private readonly logger: AppLogger = new AppLogger('GithubService'),
  ) {}

  async listRepos(query: ListReposQueryInput, installationId: number): Promise<GithubRepo[]> {
    const token = await this.appAuth.getInstallationToken(installationId);
    const env = validateEnv(process.env);
    const { page, per_page } = query;

    const octokit = new Octokit({
      auth: token,
      baseUrl: env.githubApiUrl,
      ...(fetchImplForTests ? { request: { fetch: fetchImplForTests } } : {}),
    });

    let lastAttempt = 1;
    try {
      const res = await withRetry(
        async (attempt) => {
          lastAttempt = attempt;
          if (attempt > 1) {
            this.logger.warn(
              `[github] repos retry attempt=${attempt} installation=${installationId}`,
            );
          }
          return octokit.request('GET /installation/repositories', {
            per_page,
            page,
          });
        },
        { method: 'GET', ...this.retryDefaults() },
      );
      const data = res.data as InstallationReposResponse;
      const repos = Array.isArray(data.repositories) ? data.repositories : [];
      // Per-request listing on a hot path → debug (not info).
      this.logger.debug('[github] repos listed');
      return repos.map((r) => this.normalize(r));
    } catch (err) {
      throw this.toHttpError(err, lastAttempt);
    }
  }

  /** EXTERNAL_RETRY_* tuning (silent env defaults, fail-open to 3/200/2000). */
  private retryDefaults(): { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } {
    try {
      const env = validateEnv(process.env);
      return {
        maxAttempts: env.externalRetryMaxAttempts,
        baseDelayMs: env.externalRetryBaseDelayMs,
        maxDelayMs: env.externalRetryMaxDelayMs,
      };
    } catch {
      return { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 };
    }
  }

  private normalize(r: NonNullable<InstallationReposResponse['repositories']>[number]): GithubRepo {
    const fullName = typeof r.full_name === 'string' ? r.full_name : '';
    const [ownerFromFull] = fullName.split('/');
    const owner = r.owner?.login ?? ownerFromFull ?? '';
    const name = r.name ?? fullName.split('/')[1] ?? '';
    return {
      id: typeof r.id === 'number' ? r.id : 0,
      owner,
      name,
      fullName,
      private: Boolean(r.private),
      defaultBranch: r.default_branch ?? 'main',
      url:
        r.html_url ??
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
  private toHttpError(err: unknown, attempt = 1): Error {
    const status =
      err instanceof ExternalServiceError && err.status !== undefined
        ? err.status
        : typeof err === 'object' && err !== null && 'status' in err
          ? Number((err as { status?: unknown }).status)
          : NaN;
    // Fixed messages + status in logs only; upstream bodies may embed
    // ids/urls but never our key/token (we never log err content).
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
    const external = fromUnknown('github', 'listRepos', err, attempt);
    this.logger.warn(
      `[github] repos transport failure code=${external.code} attempt=${external.attempt}`,
    );
    // Retryable transport failures (429/5xx/timeout/network, possibly after
    // retries) surface typed: api-error.filter maps them to 429/503/504 with
    // the same { code, message, correlationId } envelope.
    return external;
  }
}
