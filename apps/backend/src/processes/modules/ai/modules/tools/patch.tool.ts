import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { resolveToolPath } from './utils/tool-jail';
import type { ToolContext, ToolDefinition, ToolHandler } from '../tool-runtime/tool-runtime.types';

const inputSchema: z.ZodType<{ patch: string }> = z.object({
  patch: z.string({ error: 'field "patch" is required' }).min(1),
});

type HunkLine = { kind: ' ' | '-' | '+'; text: string };
type Hunk = { oldStart: number; lines: Array<HunkLine> };

/** One file section of a unified diff (`--- a/x` / `+++ b/x` + hunks). */
export type PatchSection = { file: string; hunks: Array<Hunk> };

/** Split a unified diff into per-file sections (no filesystem access). */
export function parseUnifiedPatch(patch: string): Array<PatchSection> {
  const lines: Array<string> = patch.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<PatchSection> = [];
  let current: PatchSection | null = null;
  let hunk: Hunk | null = null;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const raw: string = line.slice(4).trim().split(/\s+/)[0] ?? '';
      const file: string = raw.replace(/^[ab]\//, '');
      current = { file, hunks: [] };
      sections.push(current);
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
      hunk = null;
      continue;
    }
    const header: RegExpMatchArray | null = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (header) {
      hunk = { oldStart: Number(header[1]), lines: [] };
      if (!current) throw new Error('hunk without a file header');
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const kind: string = line.charAt(0);
    if (kind === ' ' || kind === '-' || kind === '+') {
      hunk.lines.push({ kind: kind as HunkLine['kind'], text: line.slice(1) });
    }
  }
  return sections.filter((section) => section.file.length > 0 && section.hunks.length > 0);
}

/** Apply parsed hunks to one file body; strict context match, no fuzzing. */
export function applyHunks(original: string, hunks: Array<Hunk>): string {
  const source: Array<string> = original.split('\n');
  const output: Array<string> = [];
  let cursor: number = 0;
  for (const hunk of hunks) {
    const start: number = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) throw new Error('overlapping hunks');
    while (cursor < start) {
      output.push(source[cursor] as string);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.kind === '+') {
        output.push(line.text);
        continue;
      }
      if (source[cursor] !== line.text) throw new Error('patch context mismatch');
      if (line.kind === ' ') output.push(line.text);
      cursor += 1;
    }
  }
  while (cursor < source.length) {
    output.push(source[cursor] as string);
    cursor += 1;
  }
  return output.join('\n');
}

/** patch — apply a unified diff to project files (strict, jail-checked). */
@Injectable()
export class PatchTool implements ToolHandler {
  readonly fullName: string = 'patch';
  readonly definition: ToolDefinition = {
    name: 'patch',
    description: 'Apply a unified diff to project files (strict context match).',
    inputSchema: {
      type: 'object',
      required: ['patch'],
      properties: { patch: { type: 'string' } },
    },
  };

  constructor(private readonly paths: WorkspacePathService) {}

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed: z.ZodSafeParseResult<{ patch: string }> = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { patch: string }';
    let sections: Array<PatchSection>;
    try {
      sections = parseUnifiedPatch(parsed.data.patch);
    } catch (error) {
      return `error: ${(error as Error).message}`;
    }
    if (sections.length === 0) return 'error: patch carries no file sections';
    const applied: Array<string> = [];
    for (const section of sections) {
      const absolute: string = await resolveToolPath(
        this.paths,
        context.directory,
        section.file,
      );
      const original: string = await this.paths.readFile(absolute);
      let updated: string;
      try {
        updated = applyHunks(original, section.hunks);
      } catch (error) {
        return `error: ${section.file}: ${(error as Error).message}`;
      }
      await this.paths.writeFile(absolute, updated);
      applied.push(section.file);
    }
    return `patched ${applied.join(', ')}`;
  }
}
