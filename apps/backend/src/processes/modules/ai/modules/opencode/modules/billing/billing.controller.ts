import {
  Controller,
  Get,
  HttpCode,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../../../../../../auth/jwt-auth.guard";
import type { RequestIdentity } from "../../../../../../../auth/identity.service";
import { ReqUser } from "../../../../../../../auth/req-user.decorator";
import { AppLogger } from "@common/logger";
import { uuidSchema } from "@common/validation";
import { BillingService, type BillingUsage } from "./billing.service";
import { BillingUsageDto } from "./billing.dto";

/**
 * BillingController — the caller's live OpenCode usage (billing domain).
 *
 * - Requires JwtAuthGuard (login/password auth, Bearer access token). Only
 *   the identity's own user_id is ever used — there is no user-id parameter
 *   to tamper with. Non-uuid mock identities (legacy dev fallback) are
 *   rejected with 401 instead of leaking a driver error.
 * - GET /api/v1/usage — live Zen Go usage via the
 *   per-user key (missing → 404 opencode_key_missing; rejected → 401
 *   opencode_key_invalid; upstream 429 → 429 EXTERNAL_RATE_LIMITED;
 *   upstream 5xx → EXTERNAL_UPSTREAM_5XX (status passthrough: 502/500…);
 *   timeout → 504 EXTERNAL_TIMEOUT; network/non-JSON/shape-mismatch →
 *   503 EXTERNAL_UNAVAILABLE with Retry-After 30, fixed message
 *   «сервис временно недоступен, повторите позже», never a mock 200).
 */
@ApiTags("usage")
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly logger: AppLogger = new AppLogger(BillingController.name),
  ) {}

  private ownUserId(identity: RequestIdentity): string {
    if (!uuidSchema.safeParse(identity.id).success) {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
    return identity.id;
  }

  @Get("usage")
  @HttpCode(200)
  @ApiOperation({ summary: "Live OpenCode balance+usage for your stored key" })
  @ApiResponse({ status: 200, type: BillingUsageDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer or rejected key" })
  @ApiResponse({ status: 404, description: "no key stored (opencode_key_missing)" })
  @ApiResponse({ status: 429, description: "upstream rate limit (EXTERNAL_RATE_LIMITED, Retry-After)" })
  @ApiResponse({ status: 502, description: "upstream server error passthrough (EXTERNAL_UPSTREAM_5XX, Retry-After)" })
  @ApiResponse({ status: 503, description: "upstream unavailable or shape mismatch (EXTERNAL_UNAVAILABLE, Retry-After)" })
  @ApiResponse({ status: 504, description: "upstream timeout (EXTERNAL_TIMEOUT, Retry-After)" })
  async usage(
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<BillingUsageDto> {
    const correlationId: string | undefined = request?.correlationId;
    const output: BillingUsage = await this.billing.getUsage(
      this.ownUserId(identity),
      correlationId,
    );
    this.logger.debug("[opencode-billing] usage ok", correlationId);
    return output;
  }
}
