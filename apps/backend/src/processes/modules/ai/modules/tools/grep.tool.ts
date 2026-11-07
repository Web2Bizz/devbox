import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';
import { resolveToolPath } from './tool-jail';
import type { ToolContext, ToolHandler } from './tool.types';
import { matchGlob, walkFiles } from './tool-walk';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_MATCHES = 200;

const inputSchema = z.object({
  pattern: z.string({ error: 'field "pattern" is required' }).min(1),
  path: z.string().optional(),
  include: z.string().optional(),
  caseSensitive: z.boolean().optional(),
});

/** grep — jailed regexp search across project files (file:line: text). */
@Injectable()
export class GrepTool implements ToolHandler {
  readonly fullName = 'grep';
  readonly definition = {
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
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { pattern: string }';
    let regexp: RegExp;
    try {
      regexp = new RegExp(parsed.data.pattern, parsed.data.caseSensitive === true ? '' : 'i');
    } catch {
      return 'error: invalid regexp pattern';
    }
    const root = parsed.data.path
      ? await resolveToolPath(this.paths, context.directory, parsed.data.path)
      : context.directory;
    const matches: Array<string> = [];
    await walkFiles(this.paths, root, async (file) => {
      if (parsed.data.include && !matchGlob(parsed.data.include, file.relative)) return false;
      const stat = await this.paths.statPath(file.absolute);
      if (!stat || stat.size > MAX_FILE_BYTES) return false;
      let content: string;
      try {
        content = await this.paths.readFile(file.absolute);
      } catch {
        return false;
      }
      if (content.includes('\0')) return false;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!regexp.test(line)) continue;
        matches.push(`${file.relative}:${index + 1}: ${line.slice(0, 300)}`);
        if (matches.length >= MAX_MATCHES) return true;
      }
      return false;
    });
    return matches.length === 0 ? 'no matches' : matches.join('\n');
  }
}
