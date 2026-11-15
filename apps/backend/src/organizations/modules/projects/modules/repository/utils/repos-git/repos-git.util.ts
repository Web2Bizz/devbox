import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

type ExecFileAsync = (
  file: string,
  args: Array<string>,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileAsync = promisify(execFile);

/** Timeout for each git probe (no shell, no network, readonly). */
export const GIT_PROBE_TIMEOUT_MS: number = 5000;

export type GitInvalidReason = 'no-git' | 'rev-parse-failed' | 'fsck-failed' | 'timeout';

export type GitCheck = {
  ok: boolean;
  reason?: GitInvalidReason;
};

type WarnLogger = {
  warn(message: unknown): void;
};

function isTimeout(error: unknown): boolean {
  const errorShape: { killed?: boolean; signal?: string; code?: string | number } =
    error as { killed?: boolean; signal?: string; code?: string | number };
  return (
    errorShape?.killed === true ||
    errorShape?.signal === 'SIGTERM' ||
    (typeof errorShape?.code === 'string' && errorShape.code.includes('TIMEOUT')) ||
    (error instanceof Error && /timed out/i.test(error.message))
  );
}

/**
 * Readonly git validation for a scanned repo candidate.
 * - `stat <repo>/.git` must be a directory, otherwise skip as `no-git`
 *   (plain directory, not an error — no warning).
 * - `git rev-parse --git-dir --show-toplevel` + `git fsck --no-dangling`
 *   via execFile (no shell) with a 5s timeout each; failures/timeouts are
 *   `corrupted` → caller skips the repo, we `logger.warn({ path, reason })`.
 * - Never throws for a single broken repo (only unexpected stat errors
 *   propagate as-is); never logs secrets (path + reason only).
 */
export async function isValidGitRepo(
  absoluteRepoPath: string,
  logger?: WarnLogger,
): Promise<GitCheck> {
  let gitStat: Stats;
  try {
    gitStat = await stat(path.join(absoluteRepoPath, '.git'));
  } catch {
    return { ok: false, reason: 'no-git' };
  }
  if (!gitStat.isDirectory()) {
    return { ok: false, reason: 'no-git' };
  }

  const run: (
    args: Array<string>,
    reason: GitInvalidReason,
  ) => Promise<GitCheck | null> = async (args: Array<string>, reason: GitInvalidReason) => {
    try {
      await execFileAsync('git', args, {
        cwd: absoluteRepoPath,
        timeout: GIT_PROBE_TIMEOUT_MS,
      });
      return null;
    } catch (error) {
      const invalidReason: GitInvalidReason = isTimeout(error) ? 'timeout' : reason;
      logger?.warn({ path: absoluteRepoPath, reason: invalidReason });
      return { ok: false, reason: invalidReason };
    }
  };

  const rev: GitCheck | null = await run(
    ['rev-parse', '--git-dir', '--show-toplevel'],
    'rev-parse-failed',
  );
  if (rev) return rev;
  const fsck: GitCheck | null = await run(['fsck', '--no-dangling'], 'fsck-failed');
  if (fsck) return fsck;
  return { ok: true };
}

/**
 * Current HEAD sha of a repo, or null when it is not a repo / has no commits.
 * Readonly probe (execFile, no shell, 5s timeout) — the same transport as
 * isValidGitRepo. Callers map null to an honest 400 (a run needs a baseCommit
 * for Forward-Only); never invent a sha.
 */
export async function resolveHeadOrNull(absoluteRepoPath: string): Promise<string | null> {
  try {
    // Destructuring an upstream exec result — explicit annotation cannot be expressed here.
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: absoluteRepoPath,
      timeout: GIT_PROBE_TIMEOUT_MS,
    });
    const sha: string = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
