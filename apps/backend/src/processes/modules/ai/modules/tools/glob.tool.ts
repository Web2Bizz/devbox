import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';
import { resolveToolPath } from './tool-jail';
import type { ToolContext, ToolHandler } from './tool.types';
import { matchGlob, walkFiles } from './tool-walk';

const inputSchema = z.object({
  pattern: z.string({ error: 'field "pattern" is required' }).min(1),
  path: z.string().optional(),
});

/** glob — jailed pattern listing (relative posix paths, bounded result set). */
@Injectable()
export class GlobTool implements ToolHandler {
  readonly fullName = 'glob';
  readonly definition = {
    name: 'glob',
    description: 'List project files matching a glob (** crosses dirs, * stays in one segment).',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
    },
  };

  constructor(private readonly paths: WorkspacePathService) {}

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { pattern: string, path?: string }';
    const root = parsed.data.path
      ? await resolveToolPath(this.paths, context.directory, parsed.data.path)
      : context.directory;
    const matches: Array<string> = [];
    await walkFiles(this.paths, root, (file) => {
      if (!matchGlob(parsed.data.pattern, file.relative)) return false;
      matches.push(file.relative);
      return matches.length >= 2_000;
    });
    if (matches.length === 0) return 'no matches';
    matches.sort();
    return matches.join('\n');
  }
}
