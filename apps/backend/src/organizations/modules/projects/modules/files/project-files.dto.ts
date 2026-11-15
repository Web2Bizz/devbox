import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

export type FilesQuery = {
  path: string;
  depth: number;
};

export const filesQuerySchema: z.ZodType<FilesQuery> = z.object({
  path: z.string().max(500).optional().default('.'),
  depth: z
    .union([z.string(), z.number()])
    .optional()
    .default(1)
    .transform((value) => Number(value))
    .refine((value) => Number.isInteger(value) && value >= 0 && value <= 5, {
      error: 'depth must be an integer 0-5',
    }),
});

export class FileNodeDto {
  @ApiProperty({ example: '.' })
  path!: string;

  @ApiProperty({ enum: ['file', 'dir'] })
  type!: string;

  @ApiProperty({ required: false, type: () => [FileNodeDto] })
  children?: Array<FileNodeDto>;
}
