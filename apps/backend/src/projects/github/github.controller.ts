import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
  Version,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { V1Endpoint } from "../../api/version";
import {
  DEFAULT_MOCK_USER_ID,
  resolveIdentityUserId,
} from "../../auth/identity.service";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { ReqUser } from "../../auth/req-user.decorator";
import type { RequestIdentity } from "../../auth/identity.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { validateEnv } from "../../env";
import {
  GithubCallbackResultDto,
  GithubInstallUrlDto,
  GithubRepoDto,
  GithubWebhookAckDto,
  InstallCallbackQueryDto,
  ListReposQueryDto,
  installCallbackQuerySchema,
  listReposQuerySchema,
  type InstallCallbackQueryInput,
  type ListReposQueryInput,
} from "./dto";
import { GithubInstallationsService } from "./github-installations.service";
import {
  INSTALLATION_ACTIONS,
  getRawBody,
  verifyWebhookSignature,
  type InstallationWebhookPayload,
} from "./github-webhook.util";
import { GithubAppService } from "./github-app.service";
import { GithubService } from "./github.service";

/** MVP mock user key when no identity is supplied (dev single-user). */
export { DEFAULT_MOCK_USER_ID };

/**
 * Resolves the MVP user key: x-user-id header wins, then ?userId query,
 * then the 'default' dev user. Single copy lives in
 * auth/identity.service.ts (re-exported here for compat).
 */
export { resolveIdentityUserId as resolveUserId };

/**
 * GithubController — multi-tenant GitHub App surface.
 * Global 'api' prefix + URI versioning supply /api/v1 — controller
 * declares only `projects/github`, so routes are:
 * - GET  /api/v1/projects/github/install-url (App install entrypoint)
 * - GET  /api/v1/projects/github/callback (post-install binding)
 * - POST /api/v1/projects/github/webhook (signature-verified events)
 * - GET  /api/v1/projects/github/repos (per-user installation repos)
 * 401 when GITHUB_APP_* is unconfigured; 404 GITHUB_NOT_INSTALLED when the
 * user has no installation; GithubLink endpoints untouched.
 */
@ApiTags("projects-github")
@Controller("projects/github")
export class GithubController {
  constructor(
    private readonly github: GithubService,
    private readonly appAuth: GithubAppService,
    private readonly installations: GithubInstallationsService,
  ) {}

  @Get("install-url")
  @Version("1")
  @V1Endpoint("Get the GitHub App install URL for the current user")
  @ApiResponse({ status: 200, type: GithubInstallUrlDto })
  @ApiResponse({
    status: 503,
    description: "GitHub App slug is not configured",
  })
  installUrl(): GithubInstallUrlDto {
    const env = validateEnv(process.env);
    if (!env.githubAppId || !env.githubPrivateKey || !env.githubAppSlug) {
      throw new ServiceUnavailableException(
        "GitHub App install is not configured",
      );
    }
    return {
      url: `https://github.com/apps/${env.githubAppSlug}/installations/new`,
    };
  }

  @Get("callback")
  @Version("1")
  @UseGuards(JwtAuthGuard)
  @V1Endpoint("Bind a fresh GitHub App installation to the current user")
  @ApiBearerAuth()
  @ApiQuery({
    name: "installation_id",
    required: true,
    type: Number,
    example: 789012,
  })
  @ApiQuery({
    name: "setup_action",
    required: false,
    type: String,
    example: "install",
  })
  @ApiQuery({ name: "userId", required: false, type: String, example: "dev-1" })
  @ApiHeader({
    name: "x-user-id",
    required: false,
    description: "MVP mock user key (wins over ?userId)",
  })
  @ApiResponse({ status: 200, type: GithubCallbackResultDto })
  @ApiResponse({
    status: 400,
    description: "bad query (installation_id / setup_action)",
  })
  async callback(
    @Query(new ZodValidationPipe(installCallbackQuerySchema))
    query: InstallCallbackQueryInput,
    @Req() req: unknown,
    @ReqUser() _identity?: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<GithubCallbackResultDto> {
    void _identity;
    const userId = resolveIdentityUserId(req, query.userId);
    await this.installations.upsert(
      { installationId: query.installation_id, userId },
      correlationId,
    );
    return { ok: true, installationId: query.installation_id };
  }

  @Post("webhook")
  @Version("1")
  @HttpCode(200)
  @V1Endpoint("GitHub App webhook (installation lifecycle, signature-verified)")
  @ApiResponse({ status: 200, type: GithubWebhookAckDto })
  @ApiResponse({ status: 401, description: "Invalid webhook signature" })
  @ApiResponse({ status: 503, description: "Webhook secret is not configured" })
  async webhook(
    @Body() body: InstallationWebhookPayload,
    @Req() req: unknown,
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-github-event") event?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<GithubWebhookAckDto> {
    const env = validateEnv(process.env);
    if (!env.githubWebhookSecret) {
      throw new ServiceUnavailableException("GitHub webhook is not configured");
    }
    const raw = getRawBody(req) ?? JSON.stringify(body ?? {});
    if (!verifyWebhookSignature(raw, signature, env.githubWebhookSecret)) {
      throw new UnauthorizedException("Invalid webhook signature");
    }
    // Only `installation` events mutate the registry; everything else
    // (ping, installation_repositories, …) is acked without side effects.
    if (event !== undefined && event !== "installation") return { ok: true };
    const payload = body ?? {};
    const action = typeof payload.action === "string" ? payload.action : "";
    if (action !== "" && !INSTALLATION_ACTIONS.has(action)) return { ok: true };
    // Unknown-event shape without an action (e.g. ping) → ack.
    if (action === "") return { ok: true };

    const inst = payload.installation;
    const installationId = typeof inst?.id === "number" ? inst.id : NaN;
    if (!Number.isInteger(installationId) || installationId <= 0)
      return { ok: true };
    const accountLogin =
      typeof inst?.account?.login === "string" ? inst.account.login : null;
    const accountType =
      typeof inst?.account?.type === "string" ? inst.account.type : null;

    if (action === "deleted") {
      await this.installations.removeByInstallationId(
        installationId,
        correlationId,
      );
      return { ok: true };
    }
    if (action === "suspend") {
      await this.installations.upsert(
        {
          installationId,
          accountLogin,
          accountType,
          suspendedAt: new Date().toISOString(),
        },
        correlationId,
      );
      return { ok: true };
    }
    // created / unsuspend / new_permissions_accepted → live binding
    // (userId preserved when the callback already bound it).
    await this.installations.upsert(
      {
        installationId,
        accountLogin,
        accountType,
        suspendedAt: null,
      },
      correlationId,
    );
    return { ok: true };
  }

  @Get("repos")
  @Version("1")
  @UseGuards(JwtAuthGuard)
  @V1Endpoint("List GitHub App installation repositories for the current user")
  @ApiBearerAuth()
  @ApiQuery({ name: "page", required: false, type: Number, example: 1 })
  @ApiQuery({ name: "per_page", required: false, type: Number, example: 30 })
  @ApiQuery({ name: "userId", required: false, type: String, example: "dev-1" })
  @ApiHeader({
    name: "x-user-id",
    required: false,
    description: "MVP mock user key (wins over ?userId)",
  })
  @ApiResponse({ status: 200, type: [GithubRepoDto] })
  @ApiResponse({
    status: 401,
    description: "GitHub App is not configured / auth failed",
  })
  @ApiResponse({
    status: 404,
    description: "No installation for this user (GITHUB_NOT_INSTALLED)",
  })
  async list(
    @Query(new ZodValidationPipe(listReposQuerySchema))
    query: ListReposQueryInput,
    @Req() req: unknown,
    @ReqUser() _identity?: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<GithubRepoDto[]> {
    void _identity;
    if (!this.appAuth.isConfigured()) {
      throw new UnauthorizedException("GitHub App is not configured");
    }
    const userId = resolveIdentityUserId(req, query.userId);
    const stored = await this.installations.findByUserId(userId, correlationId);
    // Legacy dev fallback: single GITHUB_APP_INSTALLATION_ID install applies
    // to the default mock user when no per-user binding exists.
    const env = validateEnv(process.env);
    const installationId =
      stored?.installationId ??
      (userId === DEFAULT_MOCK_USER_ID && env.githubInstallationId
        ? Number(env.githubInstallationId)
        : NaN);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new NotFoundException({
        code: "GITHUB_NOT_INSTALLED",
        message: "GitHub App is not installed for this user",
      });
    }
    if (stored?.suspendedAt) {
      throw new UnauthorizedException("GitHub App installation is suspended");
    }
    // Zod pipe coerces ?page=2 strings and applies defaults.
    return this.github.listRepos(query, installationId) as unknown as Promise<
      GithubRepoDto[]
    >;
  }
}

// Re-exported so swagger DTO parity tooling can import from the controller
// module without touching runtime wiring.
export type { InstallCallbackQueryDto, ListReposQueryDto };
