import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { resolveToolPath } from './utils/tool-jail';
import type { ToolContext, ToolDefinition, ToolHandler } from '../tool-runtime/tool-runtime.types';

const inputSchema: z.ZodType<{ path: string }> = z.object({
  path: z.string({ error: 'field "path" is required' }).min(1),
});

/** read — jailed UTF-8 file read; output truncated to keep prompts bounded. */
@Injectable()
export class ReadTool implements ToolHandler {
  readonly fullName: string = 'read';
  readonly definition: ToolDefinition = {
    name: 'read',
    description: 'Read a UTF-8 file inside the project directory.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  };

  constructor(private readonly paths: WorkspacePathService) {}

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed: z.ZodSafeParseResult<{ path: string }> = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { path: string }';
    const absolute: string = await resolveToolPath(
      this.paths,
      context.directory,
      parsed.data.path,
    );
    const content: string = await this.paths.readFile(absolute);
    return content.length > 200_000 ? `${content.slice(0, 200_000)}\n… (truncated)` : content;
  }
}
