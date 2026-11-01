import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

export const filesQuerySchema = z.object({
  path: z.string().max(500).optional().default('.'),
  depth: z
    .union([z.string(), z.number()])
    .optional()
    .default(1)
    .transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n >= 0 && n <= 5, {
      error: 'depth must be an integer 0-5',
    }),
});

export type FilesQuery = z.infer<typeof filesQuerySchema>;

export class FileNodeDto {
  @ApiProperty({ example: '.' })
  path!: string;

  @ApiProperty({ enum: ['file', 'dir'] })
  type!: string;

  @ApiProperty({ required: false, type: () => [FileNodeDto] })
  children?: FileNodeDto[];
}
