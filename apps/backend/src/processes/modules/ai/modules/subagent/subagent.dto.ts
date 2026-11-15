import { ApiProperty } from '@nestjs/swagger';

/**
 * Swagger shape of one subagent-capable executor — docs only, never used for
 * validation (ZodValidationPipe owns runtime; the GET list takes no inputs).
 */
export class SubagentDto {
  @ApiProperty({ example: 'backend' })
  id!: string;

  @ApiProperty({ example: 'Backend' })
  name!: string;

  @ApiProperty({ example: 'Backend domain executor (subagent jobs only)' })
  description!: string;
}
