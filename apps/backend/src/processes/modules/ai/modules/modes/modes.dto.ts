import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/** Work-mode selector boundary schema (ask vs auto — the selector, not the agent). */
export const agentWorkModeSchema: z.ZodEnum<{ ask: 'ask'; auto: 'auto' }> = z.enum([
  'ask',
  'auto',
]);

/** Work mode validated at the boundary. */
export type AgentWorkModeInput = z.infer<typeof agentWorkModeSchema>;

/** Swagger shape — docs only, never used for validation (ZodValidationPipe owns runtime). */
export class ModeDto {
  @ApiProperty({ example: 'ask' })
  mode!: string;

  @ApiProperty({ example: 'single-answer' })
  workflow!: string;

  @ApiProperty({ example: 'Single-answer mode: one direct answer, no steps' })
  description!: string;
}
