import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { validateEnv } from "../../../../../common/env/env";
import { GithubAppService } from "./github-app.service";
import { GithubInstallationsService } from "./github-installations.service";
import type { InstallCallbackQueryInput } from "./github.dto";
import { signAppState, verifyAppState } from "./utils/app-state";

const CLOCK_SKEW_MS = 5 * 60_000;

function isFreshInstallation(
  createdAt: string | null,
  issuedAt: number,
): boolean {
  if (createdAt === null) return false;
  const createdMs = Date.parse(createdAt);
  return Number.isFinite(createdMs) && createdMs >= issuedAt - CLOCK_SKEW_MS;
}

@Injectable()
export class GithubBindingService {
  constructor(
    private readonly appAuth: GithubAppService,
    private readonly installations: GithubInstallationsService,
  ) {}

  private stateSecret(): string {
    const env = validateEnv(process.env);
    const secret = env.githubStateSecret || env.githubWebhookSecret;
    if (!secret) {
      throw new ServiceUnavailableException(
        "GitHub install state is not configured",
      );
    }
    return secret;
  }

  buildInstallUrl(userId: string): string {
    const env = validateEnv(process.env);
    if (!env.githubAppId || !env.githubPrivateKey || !env.githubAppSlug) {
      throw new ServiceUnavailableException(
        "GitHub App install is not configured",
      );
    }
    const state = signAppState(userId, this.stateSecret());
    return `https://github.com/apps/${env.githubAppSlug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  async bindInstallation(
    userId: string,
    query: InstallCallbackQueryInput,
    correlationId?: string,
  ): Promise<number> {
    const verified = verifyAppState(query.state, this.stateSecret());
    if (!verified.ok) {
      throw new BadRequestException({
        code: "GITHUB_STATE_INVALID",
        message: "GitHub App install state is invalid or expired",
      });
    }
    if (verified.payload.userId !== userId) {
      throw new ForbiddenException({
        code: "GITHUB_STATE_FORBIDDEN",
        message: "GitHub App install state belongs to another user",
      });
    }

    const known = await this.installations.findByInstallationId(
      query.installation_id,
      correlationId,
    );
    const installation = await this.appAuth.getInstallation(
      query.installation_id,
    );
    if (
      known !== null &&
      typeof known.userId === "string" &&
      known.userId !== userId
    ) {
      throw new ForbiddenException({
        code: "GITHUB_INSTALLATION_FORBIDDEN",
        message: "GitHub App installation belongs to another user",
      });
    }
    if (
      (known === null || known.userId === null) &&
      !isFreshInstallation(installation.createdAt, verified.payload.iat)
    ) {
      throw new ForbiddenException({
        code: "GITHUB_INSTALLATION_FORBIDDEN",
        message: "GitHub App installation predates the install state",
      });
    }

    await this.installations.upsert(
      {
        installationId: query.installation_id,
        userId,
        accountLogin: installation.account?.login ?? null,
        accountType: installation.account?.type ?? null,
      },
      correlationId,
      known,
    );
    return query.installation_id;
  }
}
