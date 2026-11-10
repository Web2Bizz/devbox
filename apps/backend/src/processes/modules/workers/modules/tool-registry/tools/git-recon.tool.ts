import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolContext, ToolDescriptor } from '../tool-registry';

/** Promisified `execFile` narrowed to the call shape this tool uses. */
type ExecFileAsync = (
  file: string,
  args: ReadonlyArray<string>,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileAsync = promisify(execFile);

/** Read-only git probes never need more than a few seconds. */
const GIT_PROBE_TIMEOUT_MS: number = 5000;

/** Cap on the dirty list written into the step result (journal stays small). */
const MAX_DIRTY_LINES: number = 200;

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
    handler: async (input: Record<string, unknown>, context: ToolContext) => {
      const requestedPath: unknown = input.path;
      const cwd: string =
        typeof requestedPath === 'string' && requestedPath.length > 0
          ? requestedPath
          : context.cwd;
      // Destructuring an upstream exec result — explicit annotation cannot be expressed here.
      const { stdout: headOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd,
        timeout: GIT_PROBE_TIMEOUT_MS,
      });
      // Destructuring an upstream exec result — explicit annotation cannot be expressed here.
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd,
        timeout: GIT_PROBE_TIMEOUT_MS,
      });
      const dirty: Array<string> = statusOut
        .split('\n')
        .filter((line) => line.length > 0)
        .slice(0, MAX_DIRTY_LINES);
      return { head: headOut.trim(), dirty };
    },
  };
}
