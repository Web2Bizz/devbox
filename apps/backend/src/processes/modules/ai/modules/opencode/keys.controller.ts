import {
  Body,
  Controller,
  Delete,
  Get,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../../../../auth/jwt-auth.guard";
import type { RequestIdentity } from "../../../../../auth/identity.service";
import { ReqUser } from "../../../../../auth/req-user.decorator";
import { ZodValidationPipe } from "../../../../../common/validation";
import { CryptoService } from "../../../../../common/crypto/crypto.service";
import { opencodeKeySchema, type OpencodeKeyInput } from "../../../../../common/keys/keys.schema";
import {
  OpencodeKeyBodyDto,
  OpencodeKeyDeleteResultDto,
  OpencodeKeyResultDto,
  OpencodeKeyStatusDto,
} from "./keys.dto";
import { OpencodeKeysService } from "../../../../../common/keys/opencode-keys.service";

function isUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * OpencodeKeysController — the caller's own OpenCode API key.
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
 * - GET /api/v1/usage lives in the billing domain (modules/billing/
 *   billing.controller.ts, BillingController).
 */
@ApiTags("opencode-keys")
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class OpencodeKeysController {
  constructor(
    private readonly keys: OpencodeKeysService,
    private readonly crypto: CryptoService,
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
  @ApiOperation({ summary: "Store your own OpenCode API key (encrypted at rest)" })
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
    // Encrypt first (fail-fast 500 when unconfigured), persist ciphertext only
    // (envelope carries the active KEK id for rotation dual-read).
    const enc = this.crypto.encrypt((body as OpencodeKeyBodyDto).apiKey);
    const stored = await this.keys.save(
      userId,
      { encryptedKey: enc.data, iv: enc.iv, keyId: enc.keyId },
      correlationId,
    );
    return { ok: true, updatedAt: stored.updatedAt };
  }

  @Get("key")
  @ApiOperation({ summary: "Whether you have an OpenCode API key stored" })
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
  @ApiOperation({ summary: "Delete your stored OpenCode API key" })
  @ApiResponse({ status: 200, type: OpencodeKeyDeleteResultDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  async deleteKey(
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OpencodeKeyDeleteResultDto> {
    await this.keys.deleteByUserId(this.ownUserId(identity), req?.correlationId);
    return { ok: true };
  }
}
