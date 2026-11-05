import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDescriptor } from '../tool-registry';

const execFileAsync = promisify(execFile);

/** Read-only git probes never need more than a few seconds. */
const GIT_PROBE_TIMEOUT_MS = 5000;

/** Cap on the dirty list written into the step result (journal stays small). */
const MAX_DIRTY_LINES = 200;

/**
 * native:git.recon — the prototype's first native tool.
 *
 * Read-only by construction: it reports HEAD and the dirty files of the run
 * worktree. Git failures propagate (the claim loop records step.failed with a
 * fixed code) instead of being swallowed into an empty success.
 */
export function createGitReconTool(): ToolDescriptor {
  return {
    view: {
      id: 'native:git.recon',
      title: 'Git recon',
      description: 'Read the current HEAD and dirty files of the run worktree (read-only).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        additionalProperties: false,
      },
    },
    effects: ['read'],
    handler: async (input, ctx) => {
      const requestedPath = input.path;
      const cwd =
        typeof requestedPath === 'string' && requestedPath.length > 0 ? requestedPath : ctx.cwd;
      const { stdout: headOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd,
        timeout: GIT_PROBE_TIMEOUT_MS,
      });
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd,
        timeout: GIT_PROBE_TIMEOUT_MS,
      });
      const dirty = statusOut
        .split('\n')
        .filter((line) => line.length > 0)
        .slice(0, MAX_DIRTY_LINES);
      return { head: headOut.trim(), dirty };
    },
  };
}
