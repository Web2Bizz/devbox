import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

export const createChatSchema = z.object({
  title: z.string({ error: 'Field "title" is required' }).min(1).max(200),
});

export type CreateChatInput = z.infer<typeof createChatSchema>;

export class CreateChatDto {
  @ApiProperty({ example: 'Refactor auth' })
  title!: string;
}

export class ProjectChatDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
