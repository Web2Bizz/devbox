import { ApiProperty } from '@nestjs/swagger';

/**
 * Vault DTO — thin @nestjs/swagger wrappers mirroring
 * contracts/openapi.yaml (vault section). Runtime validation stays zod
 * (`vaultSecretInputSchema` / `vaultSecretUpdateSchema` from
 * @rush-code/contracts). Ciphertext never crosses the wire: the info DTO
 * carries identity, label and timestamps only, and the input DTO is
 * write-only.
 */
export class VaultSecretInfoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'opencode' })
  provider!: string;

  @ApiProperty({ example: 'primary' })
  label!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class VaultSecretListDto {
  @ApiProperty({ type: [VaultSecretInfoDto] })
  secrets!: Array<VaultSecretInfoDto>;
}

export class VaultSecretInputDto {
  @ApiProperty({ example: 'opencode' })
  provider!: string;

  @ApiProperty({ example: 'opencode_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', minLength: 20, maxLength: 1024 })
  apiKey!: string;

  @ApiProperty({ required: false, maxLength: 64, example: 'primary' })
  label?: string;
}

export class VaultSecretUpdateInputDto {
  @ApiProperty({ required: false, minLength: 20, maxLength: 1024 })
  apiKey?: string;

  @ApiProperty({ required: false, maxLength: 64, example: 'rotated' })
  label?: string;
}

export class VaultSecretDeleteResultDto {
  @ApiProperty({ example: true })
  ok!: boolean;
}
