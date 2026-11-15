import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { resolveToolPath } from './utils/tool-jail';
import type { ToolContext, ToolDefinition, ToolHandler } from '../tool-runtime/tool-runtime.types';

const inputSchema: z.ZodType<{
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}> = z.object({
  path: z.string({ error: 'field "path" is required' }).min(1),
  oldString: z.string({ error: 'field "oldString" is required' }).min(1),
  newString: z.string({ error: 'field "newString" is required' }),
  replaceAll: z.boolean().optional(),
});

/**
 * edit — exact-string replacement. A missing target answers an error-result;
 * a non-unique target fails unless `replaceAll` is explicit (never a silent
 * first-match edit of the wrong occurrence).
 */
@Injectable()
export class EditTool implements ToolHandler {
  readonly fullName: string = 'edit';
  readonly definition: ToolDefinition = {
    name: 'edit',
    description: 'Replace an exact string in a project file (unique unless replaceAll).',
    inputSchema: {
      type: 'object',
      required: ['path', 'oldString', 'newString'],
      properties: {
        path: { type: 'string' },
        oldString: { type: 'string' },
        newString: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
    },
  };

  constructor(private readonly paths: WorkspacePathService) {}

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed: z.ZodSafeParseResult<{
      path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }> = inputSchema.safeParse(input);
    if (!parsed.success) {
      return 'error: invalid input, expected { path: string, oldString: string, newString: string }';
    }
    const relative: string = parsed.data.path;
    const oldString: string = parsed.data.oldString;
    const newString: string = parsed.data.newString;
    const replaceAll: boolean | undefined = parsed.data.replaceAll;
    const absolute: string = await resolveToolPath(this.paths, context.directory, relative);
    const original: string = await this.paths.readFile(absolute);
    const first: number = original.indexOf(oldString);
    if (first < 0) return `error: oldString not found in ${relative}`;
    const second: number = original.indexOf(oldString, first + oldString.length);
    if (second >= 0 && replaceAll !== true) {
      return `error: oldString is not unique in ${relative}, pass replaceAll: true`;
    }
    const updated: string =
      replaceAll === true
        ? original.split(oldString).join(newString)
        : original.slice(0, first) + newString + original.slice(first + oldString.length);
    await this.paths.writeFile(absolute, updated);
    return `edited ${relative}`;
  }
}
