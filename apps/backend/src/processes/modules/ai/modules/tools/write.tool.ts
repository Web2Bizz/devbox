import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { z } from 'zod';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { resolveToolPath } from './utils/tool-jail';
import type { ToolContext, ToolDefinition, ToolHandler } from '../tool-runtime/tool-runtime.types';

const inputSchema: z.ZodType<{ path: string; content: string }> = z.object({
  path: z.string({ error: 'field "path" is required' }).min(1),
  content: z.string({ error: 'field "content" is required' }),
});

/** write — jailed UTF-8 file write (missing parent dirs are created). */
@Injectable()
export class WriteTool implements ToolHandler {
  readonly fullName: string = 'write';
  readonly definition: ToolDefinition = {
    name: 'write',
    description: 'Write a UTF-8 file inside the project directory (creates parent dirs).',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    },
  };

  constructor(private readonly paths: WorkspacePathService) {}

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed: z.ZodSafeParseResult<{ path: string; content: string }> =
      inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { path: string, content: string }';
    const absolute: string = await resolveToolPath(
      this.paths,
      context.directory,
      parsed.data.path,
    );
    await this.paths.ensureDir(path.dirname(absolute));
    await this.paths.writeFile(absolute, parsed.data.content);
    return `wrote ${parsed.data.content.length} bytes to ${parsed.data.path}`;
  }
}
