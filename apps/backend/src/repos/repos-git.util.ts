import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Timeout for each git probe (no shell, no network, readonly). */
export const GIT_PROBE_TIMEOUT_MS = 5000;

export type GitInvalidReason = 'no-git' | 'rev-parse-failed' | 'fsck-failed' | 'timeout';

export type GitCheck = {
  ok: boolean;
  reason?: GitInvalidReason;
};

type WarnLogger = {
  warn(message: unknown): void;
};

function isTimeout(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string; code?: string | number };
  return (
    e?.killed === true ||
    e?.signal === 'SIGTERM' ||
    (typeof e?.code === 'string' && e.code.includes('TIMEOUT')) ||
    (err instanceof Error && /timed out/i.test(err.message))
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
  absRepoPath: string,
  logger?: WarnLogger,
): Promise<GitCheck> {
  let gitStat;
  try {
    gitStat = await stat(path.join(absRepoPath, '.git'));
  } catch {
    return { ok: false, reason: 'no-git' };
  }
  if (!gitStat.isDirectory()) {
    return { ok: false, reason: 'no-git' };
  }

  const run = async (args: string[], reason: GitInvalidReason): Promise<GitCheck | null> => {
    try {
      await execFileAsync('git', args, {
        cwd: absRepoPath,
        timeout: GIT_PROBE_TIMEOUT_MS,
      });
      return null;
    } catch (err) {
      const r: GitInvalidReason = isTimeout(err) ? 'timeout' : reason;
      logger?.warn({ path: absRepoPath, reason: r });
      return { ok: false, reason: r };
    }
  };

  const rev = await run(['rev-parse', '--git-dir', '--show-toplevel'], 'rev-parse-failed');
  if (rev) return rev;
  const fsck = await run(['fsck', '--no-dangling'], 'fsck-failed');
  if (fsck) return fsck;
  return { ok: true };
}
