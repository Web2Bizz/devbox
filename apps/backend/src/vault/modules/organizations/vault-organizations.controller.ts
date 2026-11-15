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
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import type { RequestIdentity } from '../../../auth/identity.service';
import { ReqUser } from '../../../auth/req-user.decorator';
import type { VaultConsumer, VaultSecret } from '@common/vault/vault.types';
import { VaultService } from '@common/vault/vault.service';
import { ZodValidationPipe } from '@common/validation';
import { OrganizationsGuard } from '../../../organizations/organizations.guard';
import {
  VaultSecretDeleteResultDto,
  VaultSecretInfoDto,
  VaultSecretInputDto,
  VaultSecretListDto,
  VaultSecretUpdateInputDto,
} from '../../vault.dto';
import { ownUserId, toInfo } from '../../utils/secret-view';

/**
 * VaultOrganizationsController — organization-scoped vault secrets.
 *
 * Nested module (CoC §1.1): the organization resource is a second scope, so
 * it lives under `vault/modules/organizations/` with its own controller and
 * module instead of crowding VaultController (which owns only `/vault/secrets`).
 *
 * - Every route requires JwtAuthGuard (Bearer access token) and `:orgId`
 *   (ParseUUIDPipe) before touching the store.
 * - Reads call `OrganizationsGuard.memberRowOrThrow` (stranger → 404, the
 *   org's existence is not leaked); mutations call `maintainerOrThrow`
 *   (plain member → 403).
 * - The identity uuid guard fails closed 401 on non-uuid mock identities.
 * - Responses carry identity, label and timestamps only — never ciphertext,
 *   iv or key_id; missing/foreign ids answer 404 `vault_secret_not_found`.
 * - Swagger annotations mirror contracts/openapi.yaml (vault section).
 */
@ApiTags('vault')
@ApiBearerAuth()
@Controller('vault/organizations')
@UseGuards(JwtAuthGuard)
export class VaultOrganizationsController {
  constructor(
    private readonly vault: VaultService,
    private readonly orgGuard: OrganizationsGuard,
  ) {}

  private orgConsumer(orgId: string): VaultConsumer {
    return { kind: 'org', organizationId: orgId };
  }

  @Get(':orgId/secrets')
  @ApiOperation({ summary: 'List organization vault secrets (members only)' })
  @ApiResponse({ status: 200, type: VaultSecretListDto })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 404, description: 'not found (or not a member)' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async listOrgSecrets(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretListDto> {
    const userId: string = ownUserId(identity);
    await this.orgGuard.memberRowOrThrow(orgId, userId, request?.correlationId);
    const secrets: Array<VaultSecret> = await this.vault.list(
      this.orgConsumer(orgId),
      undefined,
      request?.correlationId,
    );
    return { secrets: secrets.map(toInfo) };
  }

  @Post(':orgId/secrets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Store an organization vault secret (maintainer only)' })
  @ApiBody({ type: VaultSecretInputDto })
  @ApiResponse({ status: 201, type: VaultSecretInfoDto })
  @ApiResponse({ status: 400, description: 'bad request (validation)' })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 403, description: 'member without the maintainer role' })
  @ApiResponse({ status: 404, description: 'not found (or not a member)' })
  @ApiResponse({ status: 500, description: 'key storage is not configured (code opencode_keys_unconfigured)' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async createOrgSecret(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @ReqUser() identity: RequestIdentity,
    @Body(new ZodValidationPipe(vaultSecretInputSchema)) body: VaultSecretInput,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretInfoDto> {
    const userId: string = ownUserId(identity);
    await this.orgGuard.maintainerOrThrow(orgId, userId, request?.correlationId);
    const secret: VaultSecret = await this.vault.create(
      this.orgConsumer(orgId),
      body,
      request?.correlationId,
    );
    return toInfo(secret);
  }

  @Get(':orgId/secrets/:id')
  @ApiOperation({ summary: 'Get one organization vault secret (members only)' })
  @ApiResponse({ status: 200, type: VaultSecretInfoDto })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 404, description: 'not found (or not a member/secret)' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async getOrgSecret(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretInfoDto> {
    const userId: string = ownUserId(identity);
    await this.orgGuard.memberRowOrThrow(orgId, userId, request?.correlationId);
    const secret: VaultSecret | null = await this.vault.get(
      this.orgConsumer(orgId),
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

  @Put(':orgId/secrets/:id')
  @ApiOperation({ summary: 'Update an organization vault secret (maintainer only)' })
  @ApiBody({ type: VaultSecretUpdateInputDto })
  @ApiResponse({ status: 200, type: VaultSecretInfoDto })
  @ApiResponse({ status: 400, description: 'bad request (validation)' })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 403, description: 'member without the maintainer role' })
  @ApiResponse({ status: 404, description: 'not found (or not a member/secret)' })
  @ApiResponse({ status: 500, description: 'key storage is not configured (code opencode_keys_unconfigured)' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async updateOrgSecret(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqUser() identity: RequestIdentity,
    @Body(new ZodValidationPipe(vaultSecretUpdateSchema)) body: VaultSecretUpdateInput,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretInfoDto> {
    const userId: string = ownUserId(identity);
    await this.orgGuard.maintainerOrThrow(orgId, userId, request?.correlationId);
    const secret: VaultSecret | null = await this.vault.update(
      this.orgConsumer(orgId),
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

  @Delete(':orgId/secrets/:id')
  @ApiOperation({ summary: 'Delete an organization vault secret (maintainer only)' })
  @ApiResponse({ status: 200, type: VaultSecretDeleteResultDto })
  @ApiResponse({ status: 401, description: 'missing/invalid bearer' })
  @ApiResponse({ status: 403, description: 'member without the maintainer role' })
  @ApiResponse({ status: 404, description: 'not found (or not a member/secret)' })
  @ApiResponse({ status: 503, description: 'postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async deleteOrgSecret(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<VaultSecretDeleteResultDto> {
    const userId: string = ownUserId(identity);
    await this.orgGuard.maintainerOrThrow(orgId, userId, request?.correlationId);
    const removed: boolean = await this.vault.remove(
      this.orgConsumer(orgId),
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
