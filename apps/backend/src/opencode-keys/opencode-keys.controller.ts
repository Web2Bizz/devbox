import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiBearerAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import { V1Endpoint } from "../api/version.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import type { RequestIdentity } from "../auth/identity.service.js";
import { ReqUser } from "../auth/req-user.decorator.js";
import { AppLogger } from "../common/app-logger.service.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { CryptoService } from "./crypto.service.js";
import { opencodeKeySchema, type OpencodeKeyInput } from "./dto.js";
import { OpencodeBillingService } from "./opencode-billing.service.js";
import {
  OpencodeKeyBodyDto,
  OpencodeKeyDeleteResultDto,
  OpencodeKeyResultDto,
  OpencodeKeyStatusDto,
  OpencodeUsageDto,
} from "./opencode-keys.dto.js";
import { OpencodeKeysService } from "./opencode-keys.service.js";

function isUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * OpencodeKeysController — the caller's own OpenCode API key + live usage.
 *
 * - All routes require JwtAuthGuard (login/password auth, Bearer access
 *   token). Only the identity's own user_id is ever read/written — there is
 *   no user-id parameter to tamper with. Non-uuid mock identities (legacy
 *   dev fallback) are rejected with 401 instead of leaking a driver error.
 * - PUT /api/v1/key { apiKey } — zod-validated, encrypted with
 *   CryptoService (AES-256-GCM) before storage; answers { ok, updatedAt }
 *   (the key is never returned, never logged).
 * - GET /api/v1/key — { configured, updatedAt? } (existence only).
 * - DELETE /api/v1/key — idempotent { ok: true }.
 * - GET /api/v1/usage — { balance, usage, updatedAt } via the
 *   per-user key (missing → 404 opencode_key_missing; rejected → 401
 *   opencode_key_invalid; upstream outage → 429/5xx typed errors).
 */
@ApiTags("opencode-keys")
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class OpencodeKeysController {
  constructor(
    private readonly keys: OpencodeKeysService,
    private readonly crypto: CryptoService,
    private readonly billing: OpencodeBillingService,
    private readonly logger: AppLogger = new AppLogger("OpencodeKeysController"),
  ) {}

  private ownUserId(identity: RequestIdentity): string {
    if (!isUserId(identity.id)) {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
    return identity.id;
  }

  @Put("key")
  @Version("1")
  @V1Endpoint("Store your own OpenCode API key (encrypted at rest)")
  @ApiResponse({ status: 200, type: OpencodeKeyResultDto })
  @ApiResponse({ status: 400, description: "bad request (validation)" })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  async putKey(
    @ReqUser() identity: RequestIdentity,
    @Body(new ZodValidationPipe(opencodeKeySchema)) body: OpencodeKeyInput,
    @Req() req?: { correlationId?: string },
  ): Promise<OpencodeKeyResultDto> {
    const userId = this.ownUserId(identity);
    const correlationId = req?.correlationId;
    // Encrypt first (fail-fast 500 when unconfigured), persist ciphertext only.
    const enc = this.crypto.encrypt((body as OpencodeKeyBodyDto).apiKey);
    const stored = await this.keys.save(
      userId,
      { encryptedKey: enc.data, iv: enc.iv },
      correlationId,
    );
    return { ok: true, updatedAt: stored.updatedAt };
  }

  @Get("key")
  @Version("1")
  @V1Endpoint("Whether you have an OpenCode API key stored")
  @ApiResponse({ status: 200, type: OpencodeKeyStatusDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  async keyStatus(
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OpencodeKeyStatusDto> {
    const stored = await this.keys.findByUserId(
      this.ownUserId(identity),
      req?.correlationId,
    );
    return stored
      ? { configured: true, updatedAt: stored.updatedAt }
      : { configured: false };
  }

  @Delete("key")
  @Version("1")
  @V1Endpoint("Delete your stored OpenCode API key")
  @ApiResponse({ status: 200, type: OpencodeKeyDeleteResultDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  async deleteKey(
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OpencodeKeyDeleteResultDto> {
    await this.keys.deleteByUserId(this.ownUserId(identity), req?.correlationId);
    return { ok: true };
  }

  @Get("usage")
  @Version("1")
  @HttpCode(200)
  @V1Endpoint("Live OpenCode balance+usage for your stored key")
  @ApiResponse({ status: 200, type: OpencodeUsageDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer or rejected key" })
  @ApiResponse({ status: 404, description: "no key stored (opencode_key_missing)" })
  async usage(
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OpencodeUsageDto> {
    const correlationId = req?.correlationId;
    const out = await this.billing.getUsage(this.ownUserId(identity), correlationId);
    this.logger.debug("[opencode-keys] usage ok", correlationId);
    return out;
  }
}
