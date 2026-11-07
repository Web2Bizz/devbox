import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';
import { resolveToolPath } from './tool-jail';
import type { ToolContext, ToolHandler } from './tool.types';

const inputSchema = z.object({
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
  readonly fullName = 'edit';
  readonly definition = {
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
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return 'error: invalid input, expected { path: string, oldString: string, newString: string }';
    }
    const { path: rel, oldString, newString, replaceAll } = parsed.data;
    const abs = await resolveToolPath(this.paths, context.directory, rel);
    const original = await this.paths.readFile(abs);
    const first = original.indexOf(oldString);
    if (first < 0) return `error: oldString not found in ${rel}`;
    const second = original.indexOf(oldString, first + oldString.length);
    if (second >= 0 && replaceAll !== true) {
      return `error: oldString is not unique in ${rel}, pass replaceAll: true`;
    }
    const updated =
      replaceAll === true ? original.split(oldString).join(newString) : original.slice(0, first) + newString + original.slice(first + oldString.length);
    await this.paths.writeFile(abs, updated);
    return `edited ${rel}`;
  }
}
