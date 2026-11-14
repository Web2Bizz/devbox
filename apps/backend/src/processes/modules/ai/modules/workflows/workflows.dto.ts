import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/** Workflow id boundary schema (single-answer vs routed-chain). */
export const agentWorkflowIdSchema: z.ZodEnum<{
  'single-answer': 'single-answer';
  'routed-chain': 'routed-chain';
}> = z.enum(['single-answer', 'routed-chain']);

/** Workflow id validated at the boundary. */
export type AgentWorkflowIdInput = z.infer<typeof agentWorkflowIdSchema>;

/** Swagger shape — docs only, never used for validation (ZodValidationPipe owns runtime). */
export class WorkflowDto {
  @ApiProperty({ example: 'single-answer' })
  id!: string;

  @ApiProperty({ example: 'Single answer' })
  name!: string;

  @ApiProperty({ example: 'One direct answer without decomposition steps' })
  description!: string;
}
