import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AppLogger } from '../common/app-logger.service';
import { ExternalServiceError } from '../common/external/external-error';
import { storageUnavailable } from '../storage/storage-unavailable';
import { isValidGitRepo } from '../repos/repos-git.util';
import { CloneJobsRepository, type CloneJob } from './clone-jobs.repository';
import { WorkspacePathService } from './workspace-path.service';
import { readSubmodules } from './workspace-submodules.util';

const execFileAsync = promisify(execFile);

/** Per-attempt budget for clone + submodule init (no shell, no secrets in logs). */
export const CLONE_TIMEOUT_MS = 120000;

function sanitizeForLog(value: string): string {
  return value.replace(/:\/\/([^/\s:@]+)(:[^/\s@]*)?@/g, '://***:***@');
}

function normalizeRepoUrl(raw: string): string {
  const url = String(raw ?? '').trim();
  if (!url) throw new BadRequestException('repoUrl must be non-empty');
  if (url.length > 2048) throw new BadRequestException('repoUrl must be at most 2048 chars');
  if (url.includes('\0')) throw new BadRequestException('repoUrl must not contain null bytes');
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(url)) {
    throw new BadRequestException(
      'repoUrl must be https://, git@, ssh://, file:// or an absolute local path',
    );
  }
  return url;
}

async function dirIsEmpty(abs: string): Promise<boolean> {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(abs);
    return entries.length === 0;
  } catch {
    return true; // missing → treated as empty (clone will create it)
  }
}

/**
 * WorkspaceCloneService — idempotent per-user `git clone` lifecycle.
 *
 * Dest is the project content dir
 * (users/<userUuid>/projects/<projectUuid>/content): both ids are
 * uuid-validated (400 on garbage), the jail rules match
 * WorkspacePathService.resolveUser (403 on traversal), and empty
 * REPOS_ROOT denies with 503 before any mkdir/clone.
 * - Lock + job key is (userId, repoName): two users cloning into different
 *   project homes never touch each other's directory; repeat calls while
 *   queued/cloning/ready return the existing job (never re-clone over it).
 * - Clone runs `git clone --recurse-submodules <url> <dest>` + `git submodule
 *   update --init --recursive` via execFile (no shell); transitions
 *   queued → cloning → ready/failed with progress hints and AppLogger
 *   entries (URLs sanitized, no tokens/keys; logs carry ids only).
 * - A failed job may be re-queued by calling `clone()` again.
 */
@Injectable()
export class WorkspaceCloneService {
  constructor(
    private readonly paths: WorkspacePathService,
    private readonly jobs: CloneJobsRepository,
    private readonly logger: AppLogger = new AppLogger('WorkspaceClone'),
  ) {}

  status(userId: string, repoName: string): CloneJob | null {
    return this.jobs.get(userId, repoName);
  }

  /**
   * Enqueue (or reuse) a clone job and run it in the background.
   * Returns the current job snapshot immediately (202 semantics).
   *
   * Unified storage gate: empty REPOS_ROOT denies with 503
   * EXTERNAL_UNAVAILABLE (logged once with the correlationId) before any
   * mkdir/clone — the dest never falls back to <cwd>/repos.
   */
  async clone(
    userId: string,
    repoUrl: string,
    repoName: string,
    correlationId?: string,
  ): Promise<CloneJob> {
    const url = normalizeRepoUrl(repoUrl);
    let resolved: Awaited<ReturnType<typeof this.paths.resolveUser>>;
    try {
      // uuid-validated user scope + project-bound dest (400 on garbage);
      // empty REPOS_ROOT denies with 503 before any mkdir/clone.
      resolved = await this.paths.resolveUser(userId, repoName);
    } catch (err) {
      if (err instanceof ExternalServiceError && err.code === 'EXTERNAL_UNAVAILABLE') {
        storageUnavailable('workspaces.clone', this.logger, correlationId, err);
      }
      throw err;
    }
    const uid = resolved.scopeId;
    const pid = resolved.projectId;
    return this.jobs.withLock(uid, pid, async () => {
      const { job, created } = this.jobs.enqueue({
        userId: uid,
        userSpace: uid,
        repoName: pid,
        repoUrl: url,
      });
      // NOTE: enqueue keyed on the normalized (userUuid, projectUuid) pair.
      void this.runClone(uid, job.repoName, url, resolved.absRepo, created);
      return this.jobs.get(uid, job.repoName) ?? job;
    });
  }

  private async runClone(
    userId: string,
    repoName: string,
    repoUrl: string,
    absDest: string,
    created: boolean,
  ): Promise<void> {
    const current = this.jobs.get(userId, repoName);
    if (!current) return;
    if (!created && current.status === 'ready') return; // idempotent: keep ready
    if (!created && (current.status === 'queued' || current.status === 'cloning')) {
      return; // a run is already in flight for this key
    }
    this.jobs.markCloning(userId, repoName);
    this.logger.info(
      `[workspaces] cloning ${sanitizeForLog(repoUrl)} → users/${userId}/projects/${repoName}`,
    );
    try {
      // Fast path: dest already holds a valid repo (manual drop or retry) → ready.
      const existing = await isValidGitRepo(absDest);
      if (existing.ok) {
        this.jobs.markReady(userId, repoName);
        this.logger.info(`[workspaces] clone ready (exists) users/${userId}/projects/${repoName}`);
        return;
      }
      const empty = await dirIsEmpty(absDest);
      if (!empty && !existing.ok) {
        throw new Error('destination exists and is not an empty directory');
      }
      await mkdir(absDest, { recursive: true });
      this.jobs.markProgress(userId, repoName, 30);
      await execFileAsync('git', ['clone', '--recurse-submodules', repoUrl, absDest], {
        timeout: CLONE_TIMEOUT_MS,
      });
      this.jobs.markProgress(userId, repoName, 80);
      try {
        await execFileAsync('git', ['submodule', 'update', '--init', '--recursive'], {
          cwd: absDest,
          timeout: CLONE_TIMEOUT_MS,
        });
      } catch (subErr) {
        // Submodule init is best-effort: the clone itself succeeded.
        this.logger.warn(
          `[workspaces] submodule init skipped for users/${userId}/projects/${repoName}: ${(subErr as Error).message}`,
        );
      }
      await readSubmodules(absDest, this.logger).catch(() => []);
      this.jobs.markReady(userId, repoName);
      this.logger.info(`[workspaces] clone ready users/${userId}/projects/${repoName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.jobs.markFailed(userId, repoName, message.slice(0, 500));
      // Terminal failure of the clone operation → error (not warn):
      // the job settled on 'failed' and the caller must retry.
      this.logger.error(
        `[workspaces] clone failed users/${userId}/projects/${repoName}: ${sanitizeForLog(message).slice(0, 200)}`,
      );
      try {
        // Best-effort cleanup of half-cloned dest (never outside the jail —
        // absDest came from WorkspacePathService.resolveUser).
        const st = await stat(absDest).catch(() => null);
        if (st && !(await isValidGitRepo(absDest)).ok) {
          const { rm } = await import('node:fs/promises');
          await rm(absDest, { recursive: true, force: true });
        }
      } catch {
        // Cleanup failure must not mask the failed status.
      }
    }
  }
}
