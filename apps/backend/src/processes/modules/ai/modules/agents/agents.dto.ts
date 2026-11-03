import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

export const askQuestionSchema = z.object({
  question: z.string().min(1, { error: 'question must be non-empty' }).max(4000, {
    error: 'question must be at most 4000 chars',
  }),
});

export type AskQuestion = z.infer<typeof askQuestionSchema>;

export class AgentDto {
  @ApiProperty({ example: 'ask' })
  id!: string;

  @ApiProperty({ example: 'Ask' })
  name!: string;

  @ApiProperty({ example: 'Answers user questions' })
  description!: string;
}

export class AskAnswerDto {
  @ApiProperty({ example: 'ask' })
  agentId!: string;

  @ApiProperty({ example: 'NestJS is a progressive Node.js framework…' })
  answer!: string;
}
