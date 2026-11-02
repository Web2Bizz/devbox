import { ApiProperty } from '@nestjs/swagger';

/**
 * Opencode boundary schemas are owned by @rush-code/contracts (single source
 * of truth, mirroring contracts/openapi.yaml). Re-exported here so existing
 * backend imports keep resolving while the contract package owns the shape.
 */
export {
  opencodeCommandSchema,
  opencodeForkSchema,
  opencodePromptSchema,
  opencodeSessionUpdateSchema,
  opencodeShellSchema,
  type OpencodeCommandInput,
  type OpencodeForkInput,
  type OpencodePromptInput,
  type OpencodeSessionUpdateInput,
  type OpencodeShellInput,
} from '@rush-code/contracts';

export class HealthDto {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ enum: ['up', 'down', 'skipped'], example: 'skipped' })
  db!: string;

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  opencode!: string;

  @ApiProperty({ enum: ['up', 'down', 'skipped'], example: 'skipped' })
  registry!: string;

  @ApiProperty({ enum: ['up', 'down', 'skipped'], example: 'skipped' })
  npmRegistry!: string;
}

export class ApiErrorDto {
  @ApiProperty({ example: 'bad_request' })
  code!: string;

  @ApiProperty({ example: 'Field "message" is required' })
  message!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  correlationId!: string;
}
