import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RunRow } from '../../../../../common/db/schema';
import { AppLogger } from '../../../../../common/logger';
import { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';

const execFileAsync = promisify(execFile);

/** Hard ceiling for one git command (no interactive prompts, no network). */
const GIT_TIMEOUT_MS = 10_000;

/** git status/commit output stays tiny; 1 MiB is already generous. */
const GIT_MAX_BUFFER = 1024 * 1024;

/**
 * Forward-Only guard on the argument list itself.
 *
 * I5 forbids rewinding history below the run's baseCommit and forbids
 * publishing with a forced push: neither `reset --hard` nor `push --force/-f`
 * may ever be constructed, even by a future bug. The claim loop only stages
 * and commits forward, so this is a belt-and-braces check, not the mechanism.
 */
function assertSafeGitArgs(args: ReadonlyArray<string>): void {
  const has = (flag: string): boolean => args.includes(flag);
  const resetHard = has('reset') && has('--hard');
  const pushForce = has('push') && (has('--force') || has('-f'));
  if (resetHard || pushForce) throw new Error('forbidden git command');
}

/**
 * RunWorktreeService — the per-run git surface of the claim loop.
 *
 * `ensure()` materializes the `<content>/wt/<run_id>` worktree on the
 * `agent/<run_id>` branch from the run's Forward-Only base commit (or attaches
 * an existing branch after a restart); `commit()` stages everything and writes
 * a deterministic trailered commit. Every git call is execFile (no shell) and
 * passes through the forbidden-argument guard.
 */
@Injectable()
export class RunWorktreeService {
  constructor(
    private readonly paths: WorkspacePathService,
    private readonly logger: AppLogger = new AppLogger(RunWorktreeService.name),
  ) {}

  /**
   * Creates (or re-attaches) the run worktree. Idempotent: an existing
   * worktree already on `run.branch` is left untouched, so a re-claimed run
   * continues instead of failing on `worktree add`.
   */
  async ensure(run: RunRow, cid: string): Promise<void> {
    await this.paths.assertInsideJail(run.worktree, await this.paths.realStrictRoot());
    // <content>/wt/<run_id> → the project checkout the worktree branches from.
    const repoRoot = path.resolve(run.worktree, '..', '..');

    try {
      const current = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], run.worktree);
      if (current === run.branch) return;
    } catch {
      // Not a worktree yet (missing dir / plain directory) — create it below.
    }

    await this.paths.ensureDir(path.dirname(run.worktree));
    const branchExists = await this.git(
      ['show-ref', '--verify', '--quiet', `refs/heads/${run.branch}`],
      repoRoot,
    )
      .then(() => true)
      .catch(() => false);

    if (branchExists) {
      await this.git(['worktree', 'add', run.worktree, run.branch], repoRoot);
    } else {
      await this.git(
        ['worktree', 'add', '-b', run.branch, run.worktree, run.baseCommit],
        repoRoot,
      );
    }
    this.logger.info('[workers] worktree ready', cid);
  }

  /**
   * Commits the worktree state as one run step. The trailer is the
   * deterministic link the journal (and later reconcile) can match on (D8).
   *
   * TODO(dual-write-reconcile): the intent/effects row and the reconcile job
   * are deferred; a git failure surfaces as step.failed and an operator sees
   * it instead of a silent half-applied step.
   */
  async commit(run: RunRow, stepSeq: number, cid: string): Promise<{ sha: string; branch: string }> {
    await this.assertForwardOnly(run);
    await this.git(['add', '-A'], run.worktree);
    const message = `chore(run): prototype step ${stepSeq}\n\nRun-Id: ${run.id}\nStep-Id: ${stepSeq}`;
    await this.git(
      [
        '-c',
        'user.name=Rush-Code-Harness',
        '-c',
        'user.email=harness@rush-code.local',
        'commit',
        '--allow-empty',
        '-m',
        message,
      ],
      run.worktree,
    );
    const sha = await this.git(['rev-parse', 'HEAD'], run.worktree);
    this.logger.info(`[workers] git.commit sha=${sha} branch=${run.branch}`, cid);
    return { sha, branch: run.branch };
  }

  /** Forward-Only: baseCommit must be an ancestor of the worktree HEAD (I5). */
  private async assertForwardOnly(run: RunRow): Promise<void> {
    try {
      await this.git(['merge-base', '--is-ancestor', run.baseCommit, 'HEAD'], run.worktree);
    } catch {
      throw new Error('forward-only violated');
    }
  }

  /** One git invocation (execFile, no shell, bounded output) → trimmed stdout. */
  private async git(args: Array<string>, cwd: string): Promise<string> {
    assertSafeGitArgs(args);
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout.trim();
  }
}
