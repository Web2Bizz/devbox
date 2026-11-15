import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  vaultSecretInputSchema,
  vaultSecretUpdateSchema,
  type VaultSecretInput,
  type VaultSecretUpdateInput,
} from '@rush-code/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { RequestIdentity } from '../auth/identity.service';
import { ReqUser } from '../auth/req-user.decorator';
import type { VaultConsumer, VaultSecret } from '@common/vault/vault.types';
import { VaultService } from '@common/vault/vault.service';
import { ZodValidationPipe } from '@common/validation';
import {
  VaultSecretDeleteResultDto,
  VaultSecretInfoDto,
  VaultSecretInputDto,
  VaultSecretListDto,
  VaultSecretUpdateInputDto,
} from './vault.dto';
import { ownUserId, toInfo } from './utils/secret-view';

/**
 * VaultController — the caller's own per-provider secret store.
 *
 * - Every route requires JwtAuthGuard (Bearer access token) and scopes to the
 *   identity's own uuid — there is no user-id parameter to tamper with;
 *   non-uuid mock identities fail closed 401 instead of leaking a driver
 *   error.
 * - Organization-scoped routes live in their own nested module/controller
 *   (`vault/modules/organizations/vault-organizations.controller.ts`, CoC
 *   §1.1) — this class owns exactly the `/vault/secrets*` user resource.
 * - The API key is write-only: `create`/`update` accept plaintext once and
 *   VaultService encrypts it (AES-256-GCM) before storage. Responses carry
 *   identity, label and timestamps only — never ciphertext, iv or key_id.
 * - Missing/foreign ids answer 404 `vault_secret_not_found` (ownership is
 *   part of the query scope, so a foreign row is indistinguishable from a
 *   missing one). Deletes are idempotent from the client's point of view by
 *   re-reading the same 404 rule.
 * - Swagger annotations mirror contracts/openapi.yaml (vault section).
 */
@ApiTags('vault')
@ApiBearerAuth()
@Controller('vault')
@UseGuards(JwtAuthGuard)
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  /** Own uuid (401 on non-uuid mock identities) wrapped in the user consumer. */
  private userConsumer(identity: RequestIdentity): VaultConsumer {
    return { kind: 'user', userId: ownUserId(identity) };
  }

  @Get('secrets')
  @ApiOperation({ summary: 'List your stored vault secrets' })
  @ApiResponse({ status: 200, type: VaultSecretListDto })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async listSecrets(
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretListDto> {
    const secrets: Array<VaultSecret> = await this.vault.list(
      this.userConsumer(identity),
      undefined,
      request?.correlationId,
    );
    return { secrets: secrets.map(toInfo) };
  }

  @Post('secrets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Store a vault secret (encrypted at rest, never echoed)' })
  @ApiBody({ type: VaultSecretInputDto })
  @ApiResponse({ status: 201, type: VaultSecretInfoDto })
  @ApiResponse({ status: 400, description: 'bad request (validation)' })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 500, description: 'key storage is not configured (code opencode_keys_unconfigured)' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async createSecret(
    @ReqUser() identity: RequestIdentity,
    @Body(new ZodValidationPipe(vaultSecretInputSchema)) body: VaultSecretInput,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretInfoDto> {
    const secret: VaultSecret = await this.vault.create(
      this.userConsumer(identity),
      body,
      request?.correlationId,
    );
    return toInfo(secret);
  }

  @Get('secrets/:id')
  @ApiOperation({ summary: 'Get one of your vault secrets (never the ciphertext)' })
  @ApiResponse({ status: 200, type: VaultSecretInfoDto })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 404, description: 'vault_secret_not_found' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async getSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretInfoDto> {
    const secret: VaultSecret | null = await this.vault.get(
      this.userConsumer(identity),
      id,
      request?.correlationId,
    );
    if (!secret) {
      throw new NotFoundException({
        code: 'vault_secret_not_found',
        message: 'Vault secret not found',
      });
    }
    return toInfo(secret);
  }

  @Put('secrets/:id')
  @ApiOperation({ summary: 'Update a vault secret (re-encrypts a new key, updates label)' })
  @ApiBody({ type: VaultSecretUpdateInputDto })
  @ApiResponse({ status: 200, type: VaultSecretInfoDto })
  @ApiResponse({ status: 400, description: 'bad request (validation)' })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 404, description: 'vault_secret_not_found' })
  @ApiResponse({ status: 500, description: 'key storage is not configured (code opencode_keys_unconfigured)' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async updateSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @ReqUser() identity: RequestIdentity,
    @Body(new ZodValidationPipe(vaultSecretUpdateSchema)) body: VaultSecretUpdateInput,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretInfoDto> {
    const secret: VaultSecret | null = await this.vault.update(
      this.userConsumer(identity),
      id,
      body,
      request?.correlationId,
    );
    if (!secret) {
      throw new NotFoundException({
        code: 'vault_secret_not_found',
        message: 'Vault secret not found',
      });
    }
    return toInfo(secret);
  }

  @Delete('secrets/:id')
  @ApiOperation({ summary: 'Delete a vault secret (404 when not owned/missing)' })
  @ApiResponse({ status: 200, type: VaultSecretDeleteResultDto })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 404, description: 'vault_secret_not_found' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async deleteSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretDeleteResultDto> {
    const removed: boolean = await this.vault.remove(
      this.userConsumer(identity),
      id,
      request?.correlationId,
    );
    if (!removed) {
      throw new NotFoundException({
        code: 'vault_secret_not_found',
        message: 'Vault secret not found',
      });
    }
    return { ok: true };
  }
}
