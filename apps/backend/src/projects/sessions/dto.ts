import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

export const createSessionSchema = z.object({
  chatId: z.string().uuid({ error: 'chatId must be a uuid' }).nullable().optional(),
  status: z.enum(['open', 'closed']).optional().default('open'),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const closeSessionSchema = z.object({
  status: z.literal('closed'),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export class CreateSessionDto {
  @ApiProperty({ required: false, format: 'uuid', nullable: true })
  chatId?: string | null;

  @ApiProperty({ required: false, enum: ['open', 'closed'], example: 'open' })
  status?: 'open' | 'closed';

  @ApiProperty({ required: false, type: Object, nullable: true })
  metadata?: Record<string, unknown> | null;
}

export class ProjectSessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ required: false, format: 'uuid', nullable: true })
  chatId!: string | null;

  @ApiProperty({ enum: ['open', 'closed'] })
  status!: string;

  @ApiProperty({ required: false, type: Object, nullable: true })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
