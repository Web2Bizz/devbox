import {
  BadRequestException,
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
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../../../../auth/jwt-auth.guard";
import { ReqUser } from "../../../../../auth/req-user.decorator";
import type { RequestIdentity } from "../../../../../auth/identity.service";
import { ZodValidationPipe } from "../../../../../common/validation";
import { validateEnv } from "../../../../../common/env/env";
import {
  GithubCallbackResultDto,
  GithubInstallUrlDto,
  GithubRepoDto,
  GithubWebhookAckDto,
  InstallCallbackQueryDto,
  ListReposQueryDto,
  installCallbackQuerySchema,
  installationWebhookSchema,
  listReposQuerySchema,
  type InstallCallbackQueryInput,
  type ListReposQueryInput,
} from "./github.dto";
import { GithubBindingService } from "./github-binding.service";
import { GithubInstallationsService } from "./github-installations.service";
import {
  INSTALLATION_ACTIONS,
  getRawBody,
  verifyWebhookSignature,
  type InstallationWebhookPayload,
} from "./utils/webhook";
import { GithubAppService } from "./github-app.service";
import { GithubService } from "./github.service";

/**
 * Webhook body validation runs manually (not as a @Body() pipe) because the
 * raw-bytes signature check MUST stay the first gate: unverified payloads
 * never reach validation.
 */
const installationWebhookPipe = new ZodValidationPipe(installationWebhookSchema);

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
 *
 * Identity (C2): userId comes ONLY from @ReqUser() (Bearer via
 * JwtAuthGuard) — the legacy x-user-id header / ?userId query spoofing is
 * removed (same ownUserId doctrine as OpencodeKeysController). A forged
 * header/query is ignored, never trusted.
 */
@ApiTags("projects-github")
@Controller("projects/github")
export class GithubController {
  constructor(
    private readonly github: GithubService,
    private readonly appAuth: GithubAppService,
    private readonly installations: GithubInstallationsService,
    private readonly binding: GithubBindingService,
  ) {}

  @Get("install-url")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Get the GitHub App install URL for the current user" })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, type: GithubInstallUrlDto })
  @ApiResponse({
    status: 503,
    description: "GitHub App slug / state secret is not configured",
  })
  installUrl(@ReqUser() identity: RequestIdentity): GithubInstallUrlDto {
    return { url: this.binding.buildInstallUrl(identity.id) };
  }

  @Get("callback")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Bind a fresh GitHub App installation to the current user" })
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
  @ApiQuery({
    name: "state",
    required: true,
    type: String,
    description: "Signed install state issued by GET /projects/github/install-url",
  })
  @ApiResponse({ status: 200, type: GithubCallbackResultDto })
  @ApiResponse({
    status: 400,
    description:
      "bad query (installation_id / setup_action / state) or invalid GITHUB_STATE_INVALID",
  })
  @ApiResponse({
    status: 403,
    description:
      "GITHUB_STATE_FORBIDDEN (state belongs to another user) / GITHUB_INSTALLATION_FORBIDDEN",
  })
  async callback(
    @Query(new ZodValidationPipe(installCallbackQuerySchema))
    query: InstallCallbackQueryInput,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<GithubCallbackResultDto> {
    const installationId = await this.binding.bindInstallation(
      identity.id,
      query,
      correlationId,
    );
    return { ok: true, installationId };
  }

  @Post("webhook")
  @HttpCode(200)
  @ApiOperation({ summary: "GitHub App webhook (installation lifecycle, signature-verified)" })
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
    // Signature verification MUST run over the exact raw bytes captured by
    // the express json verify hook. Re-serializing `body` would accept a
    // signature that GitHub never produced — refuse instead.
    const raw = getRawBody(req);
    if (raw === null) {
      throw new BadRequestException({
        code: "WEBHOOK_RAW_BODY_REQUIRED",
        message: "Webhook request is missing the captured raw body",
      });
    }
    if (!verifyWebhookSignature(raw, signature, env.githubWebhookSecret)) {
      throw new UnauthorizedException("Invalid webhook signature");
    }
    // Signature passed — now enforce the minimal body shape (zod, not a TS
    // type). Unknown keys are preserved, so installation.account.* stays
    // readable below. Non-installation events are acked before this point.
    if (event !== undefined && event !== "installation") return { ok: true };
    const payload = (await installationWebhookPipe.transform(
      body ?? {},
    )) as InstallationWebhookPayload;
    // Only `installation` events mutate the registry; everything else
    // (ping, installation_repositories, …) is acked without side effects.
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
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "List GitHub App installation repositories for the current user" })
  @ApiBearerAuth()
  @ApiQuery({ name: "page", required: false, type: Number, example: 1 })
  @ApiQuery({ name: "per_page", required: false, type: Number, example: 30 })
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
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<GithubRepoDto[]> {
    if (!this.appAuth.isConfigured()) {
      throw new UnauthorizedException("GitHub App is not configured");
    }
    const userId = identity.id;
    const stored = await this.installations.findByUserId(userId, correlationId);
    if (stored === null) {
      throw new NotFoundException({
        code: "GITHUB_NOT_INSTALLED",
        message: "GitHub App is not installed for this user",
      });
    }
    if (stored.suspendedAt) {
      throw new UnauthorizedException("GitHub App installation is suspended");
    }
    // Zod pipe coerces ?page=2 strings and applies defaults.
    return this.github.listRepos(query, stored.installationId, userId);
  }
}

// Re-exported so swagger DTO parity tooling can import from the controller
// module without touching runtime wiring.
export type { InstallCallbackQueryDto, ListReposQueryDto };
