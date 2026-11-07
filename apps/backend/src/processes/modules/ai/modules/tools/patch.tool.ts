import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';
import { resolveToolPath } from './tool-jail';
import type { ToolContext, ToolHandler } from './tool.types';

const inputSchema = z.object({
  patch: z.string({ error: 'field "patch" is required' }).min(1),
});

type HunkLine = { kind: ' ' | '-' | '+'; text: string };
type Hunk = { oldStart: number; lines: Array<HunkLine> };

/** One file section of a unified diff (`--- a/x` / `+++ b/x` + hunks). */
export type PatchSection = { file: string; hunks: Array<Hunk> };

/** Split a unified diff into per-file sections (no filesystem access). */
export function parseUnifiedPatch(patch: string): Array<PatchSection> {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<PatchSection> = [];
  let current: PatchSection | null = null;
  let hunk: Hunk | null = null;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim().split(/\s+/)[0] ?? '';
      const file = raw.replace(/^[ab]\//, '');
      current = { file, hunks: [] };
      sections.push(current);
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
      hunk = null;
      continue;
    }
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (header) {
      hunk = { oldStart: Number(header[1]), lines: [] };
      if (!current) throw new Error('hunk without a file header');
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const kind = line.charAt(0);
    if (kind === ' ' || kind === '-' || kind === '+') {
      hunk.lines.push({ kind: kind as HunkLine['kind'], text: line.slice(1) });
    }
  }
  return sections.filter((section) => section.file.length > 0 && section.hunks.length > 0);
}

/** Apply parsed hunks to one file body; strict context match, no fuzzing. */
export function applyHunks(original: string, hunks: Array<Hunk>): string {
  const source = original.split('\n');
  const out: Array<string> = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) throw new Error('overlapping hunks');
    while (cursor < start) {
      out.push(source[cursor] as string);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.kind === '+') {
        out.push(line.text);
        continue;
      }
      if (source[cursor] !== line.text) throw new Error('patch context mismatch');
      if (line.kind === ' ') out.push(line.text);
      cursor += 1;
    }
  }
  while (cursor < source.length) {
    out.push(source[cursor] as string);
    cursor += 1;
  }
  return out.join('\n');
}

/** patch — apply a unified diff to project files (strict, jail-checked). */
@Injectable()
export class PatchTool implements ToolHandler {
  readonly fullName = 'patch';
  readonly definition = {
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
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { patch: string }';
    let sections: Array<PatchSection>;
    try {
      sections = parseUnifiedPatch(parsed.data.patch);
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
    if (sections.length === 0) return 'error: patch carries no file sections';
    const applied: Array<string> = [];
    for (const section of sections) {
      const abs = await resolveToolPath(this.paths, context.directory, section.file);
      const original = await this.paths.readFile(abs);
      let updated: string;
      try {
        updated = applyHunks(original, section.hunks);
      } catch (err) {
        return `error: ${section.file}: ${(err as Error).message}`;
      }
      await this.paths.writeFile(abs, updated);
      applied.push(section.file);
    }
    return `patched ${applied.join(', ')}`;
  }
}
