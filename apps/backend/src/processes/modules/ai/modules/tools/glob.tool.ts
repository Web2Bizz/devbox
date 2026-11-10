import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { resolveToolPath } from './utils/tool-jail';
import type { ToolContext, ToolDefinition, ToolHandler } from '../tool-runtime/tool-runtime.types';
import { matchGlob } from './utils/glob-match';
import { type WalkFile, walkFiles } from './utils/tool-walk';

const inputSchema: z.ZodType<{ pattern: string; path?: string }> = z.object({
  pattern: z.string({ error: 'field "pattern" is required' }).min(1),
  path: z.string().optional(),
});

/** glob — jailed pattern listing (relative posix paths, bounded result set). */
@Injectable()
export class GlobTool implements ToolHandler {
  readonly fullName: string = 'glob';
  readonly definition: ToolDefinition = {
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
    const parsed: z.ZodSafeParseResult<{ pattern: string; path?: string }> =
      inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { pattern: string, path?: string }';
    const pattern: string = parsed.data.pattern;
    const relativePath: string | undefined = parsed.data.path;
    const root: string = relativePath
      ? await resolveToolPath(this.paths, context.directory, relativePath)
      : context.directory;
    const matches: Array<string> = [];
    await walkFiles(this.paths, root, (file: WalkFile) => {
      if (!matchGlob(pattern, file.relative)) return false;
      matches.push(file.relative);
      return matches.length >= 2_000;
    });
    if (matches.length === 0) return 'no matches';
    matches.sort();
    return matches.join('\n');
  }
}
