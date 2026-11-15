import { Injectable } from '@nestjs/common';
import { z } from 'zod/v4';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { resolveToolPath } from './utils/tool-jail';
import type { ToolContext, ToolDefinition, ToolHandler } from '../tool-runtime/tool-runtime.types';
import { matchGlob } from './utils/glob-match';
import { type WalkFile, walkFiles } from './utils/tool-walk';

const MAX_FILE_BYTES: number = 512 * 1024;
const MAX_MATCHES: number = 200;

const inputSchema: z.ZodType<{
  pattern: string;
  path?: string;
  include?: string;
  caseSensitive?: boolean;
}> = z.object({
  pattern: z.string({ error: 'field "pattern" is required' }).min(1),
  path: z.string().optional(),
  include: z.string().optional(),
  caseSensitive: z.boolean().optional(),
});

/** grep — jailed regexp search across project files (file:line: text). */
@Injectable()
export class GrepTool implements ToolHandler {
  readonly fullName: string = 'grep';
  readonly definition: ToolDefinition = {
    name: 'grep',
    description: 'Search project file contents with a JavaScript regexp (bounded matches).',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        include: { type: 'string' },
        caseSensitive: { type: 'boolean' },
      },
    },
  };

  constructor(private readonly paths: WorkspacePathService) {}

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed: z.ZodSafeParseResult<{
      pattern: string;
      path?: string;
      include?: string;
      caseSensitive?: boolean;
    }> = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { pattern: string }';
    const pattern: string = parsed.data.pattern;
    const include: string | undefined = parsed.data.include;
    const relativePath: string | undefined = parsed.data.path;
    let regexp: RegExp;
    try {
      regexp = new RegExp(pattern, parsed.data.caseSensitive === true ? '' : 'i');
    } catch {
      return 'error: invalid regexp pattern';
    }
    const root: string = relativePath
      ? await resolveToolPath(this.paths, context.directory, relativePath)
      : context.directory;
    const matches: Array<string> = [];
    await walkFiles(this.paths, root, async (file: WalkFile) => {
      if (include && !matchGlob(include, file.relative)) return false;
      const stat: Awaited<ReturnType<WorkspacePathService['statPath']>> =
        await this.paths.statPath(file.absolute);
      if (!stat || stat.size > MAX_FILE_BYTES) return false;
      let content: string;
      try {
        content = await this.paths.readFile(file.absolute);
      } catch {
        return false;
      }
      if (content.includes('\0')) return false;
      const lines: Array<string> = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line: string = lines[index] ?? '';
        if (!regexp.test(line)) continue;
        matches.push(`${file.relative}:${index + 1}: ${line.slice(0, 300)}`);
        if (matches.length >= MAX_MATCHES) return true;
      }
      return false;
    });
    return matches.length === 0 ? 'no matches' : matches.join('\n');
  }
}
