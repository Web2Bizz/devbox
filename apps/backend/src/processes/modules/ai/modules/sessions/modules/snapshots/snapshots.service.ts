import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppLogger } from '@common/logger';
import { ExternalServiceError } from '@common/external/external-error';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import type { SnapshotDiff } from '../../sessions.dto';

/** Options of one git invocation (only the knobs this service tunes). */
type GitExecOptions = {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
};

/** Promisified `execFile` narrowed to the call shape this service uses. */
type GitExecFileAsync = (
  file: string,
  args: ReadonlyArray<string>,
  options: GitExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: GitExecFileAsync = promisify(execFile);

const TREE_RE: RegExp = /^[0-9a-f]{40}$/;
const MAX_BUFFER: number = 20 * 1024 * 1024;
const GIT_TIMEOUT_MS: number = 60_000;

type GitOptions = { env?: NodeJS.ProcessEnv; timeoutMs?: number };

/** One path restored from a captured tree. */
export type RestoreEntry = { path: string; snapshot: string };

export type SnapshotRepository = { worktree: string };

/**
 * SnapshotsService — git-backed session snapshots under the project jail.
 *
 * Capture writes the working tree into a content-addressed git tree using a
 * TEMPORARY index (the real index is never touched), keeps it alive with
 * `refs/rush-code/snapshots/<tree>` and returns the tree id. Everything is
 * best-effort on capture (non-git/disabled/failure → undefined + warn) and
 * strict on restore (escape → 403, disabled/non-git → 503):
 *
 * - files(): name-only comparison of two trees,
 * - diff(): unified per-file patches,
 * - restore(): `git restore --source=<tree> --worktree` for the selected
 *   paths (a path absent from the tree is removed), index untouched.
 *
 * No pack optimisation and no 2MB untracked cap in this MVP.
 */
@Injectable()
export class SnapshotsService {
  private readonly logger: AppLogger = new AppLogger(SnapshotsService.name);

  constructor(private readonly paths: WorkspacePathService) {}

  /** True when `directory` is inside a git worktree (fast, read-only probe). */
  async isGitRepository(directory: string): Promise<boolean> {
    try {
      await this.git(directory, ['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Capture the current project tree. Returns undefined on non-git projects,
   * disabled snapshots or any git failure (warn only — a turn never fails
   * because a snapshot could not be taken).
   */
  async capture(directory: string): Promise<string | undefined> {
    try {
      const worktree: string | null = await this.worktreeOf(directory);
      if (!worktree) return undefined;
      const gitDirRaw: string = (await this.git(worktree, ['rev-parse', '--git-dir'])).trim();
      const gitDir: string = path.isAbsolute(gitDirRaw)
        ? gitDirRaw
        : path.resolve(worktree, gitDirRaw);
      const indexFile: string = path.join(
        gitDir,
        `rush-code-snapshot-${crypto.randomUUID()}.index`,
      );
      try {
        await this.git(worktree, ['add', '-A'], { env: { GIT_INDEX_FILE: indexFile } });
        const tree: string = (
          await this.git(worktree, ['write-tree'], {
            env: { GIT_INDEX_FILE: indexFile },
          })
        ).trim();
        if (!TREE_RE.test(tree)) throw new Error('bad tree id');
        await this.git(worktree, ['update-ref', `refs/rush-code/snapshots/${tree}`, tree]);
        return tree;
      } finally {
        await this.paths.removeDir(indexFile).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn('[snapshots] capture skipped code=snapshot_failed');
      this.logger.debug(error instanceof Error ? error.message : 'unknown');
      return undefined;
    }
  }

  /** Project-relative paths changed between two captured trees. */
  async files(directory: string, from: string, to: string): Promise<Array<string>> {
    this.assertTree(from);
    this.assertTree(to);
    const worktree: string = await this.requireWorktree(directory, 'files');
    const output: string = await this.git(worktree, [
      'diff-tree',
      '-r',
      '--name-only',
      '--no-commit-id',
      from,
      to,
    ]);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** Per-file unified diffs between two captured trees. */
  async diff(
    directory: string,
    from: string,
    to: string,
    context?: number,
    paths?: Array<string>,
  ): Promise<Array<SnapshotDiff>> {
    this.assertTree(from);
    this.assertTree(to);
    if (paths !== undefined && paths.length === 0) return [];
    const worktree: string = await this.requireWorktree(directory, 'diff');
    const unified: number = Math.max(0, Math.min(10, Math.floor(context ?? 3)));
    const args: Array<string> = [
      'diff-tree',
      '-r',
      '-p',
      '--no-color',
      '--no-commit-id',
      `-U${unified}`,
      from,
      to,
    ];
    if (paths && paths.length > 0) args.push('--', ...paths);
    const output: string = await this.git(worktree, args);
    return parseUnifiedDiff(output);
  }

  /**
   * Restore the selected paths from their trees. A path absent from its tree
   * is removed; paths outside the project are refused before any write.
   */
  async restore(directory: string, entries: Array<RestoreEntry>): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) this.assertTree(entry.snapshot);
    const worktree: string = await this.requireWorktree(directory, 'restore');
    for (const entry of entries) {
      const absolutePath: string = this.jail(worktree, entry.path);
      const relative: string = path.relative(worktree, absolutePath).replace(/\\/g, '/');
      const exists: boolean = await this.existsInTree(worktree, entry.snapshot, relative);
      if (exists) {
        await this.git(worktree, [
          'restore',
          `--source=${entry.snapshot}`,
          '--worktree',
          '--',
          relative,
        ]);
      } else {
        await this.paths.removeDir(absolutePath);
      }
    }
  }

  private assertTree(tree: string): void {
    if (!TREE_RE.test(tree)) throw new Error('invalid snapshot id');
  }

  /** Project-relative path → absolute path strictly inside the worktree. */
  private jail(worktree: string, relative: string): string {
    if (relative.includes('\0') || path.isAbsolute(relative)) {
      throw new Error('path escapes the project');
    }
    const absolutePath: string = path.resolve(worktree, relative);
    const withSeparator: string = worktree.endsWith(path.sep) ? worktree : worktree + path.sep;
    if (absolutePath !== worktree && !absolutePath.startsWith(withSeparator)) {
      throw new Error('path escapes the project');
    }
    return absolutePath;
  }

  private async existsInTree(worktree: string, tree: string, relative: string): Promise<boolean> {
    try {
      await this.git(worktree, ['cat-file', '-e', `${tree}:${relative}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async worktreeOf(directory: string): Promise<string | null> {
    try {
      const output: string = await this.git(directory, ['rev-parse', '--show-toplevel']);
      const worktree: string = output.trim();
      return worktree.length > 0 ? worktree : null;
    } catch {
      return null;
    }
  }

  private async requireWorktree(directory: string, operation: string): Promise<string> {
    const worktree: string | null = await this.worktreeOf(directory);
    if (!worktree) {
      this.logger.warn(`[snapshots] operation=${operation} code=not_a_git_repository`);
      throw new ExternalServiceError({
        code: 'EXTERNAL_UNAVAILABLE',
        service: 'snapshots',
        operation,
        message: 'сервис временно недоступен, повторите позже',
        isRetryable: true,
        cause: new Error('not_a_git_repository'),
      });
    }
    return worktree;
  }

  private async git(
    cwd: string,
    args: Array<string>,
    options?: GitOptions,
  ): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: options?.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...(options?.env ?? {}) },
    });
    return stdout;
  }
}

/** Split `git diff-tree -p` output into per-file rows (pure, exported for tests). */
export function parseUnifiedDiff(output: string): Array<SnapshotDiff> {
  const rows: Array<SnapshotDiff> = [];
  if (output.trim().length === 0) return rows;
  const blocks: Array<string> = output.split(/^diff --git /m).filter((block) => block.length > 0);
  for (const block of blocks) {
    const plus: RegExpMatchArray | null = block.match(/^\+\+\+ b\/(.+)$/m);
    if (!plus) continue;
    const file: string = plus[1]?.trim() ?? '';
    if (file.length === 0) continue;
    const hunkIndex: number = block.indexOf('\n@@');
    const hunks: string = hunkIndex >= 0 ? block.slice(hunkIndex + 1) : '';
    rows.push(hunks.length > 0 ? { file, hunks } : { file });
  }
  return rows;
}
