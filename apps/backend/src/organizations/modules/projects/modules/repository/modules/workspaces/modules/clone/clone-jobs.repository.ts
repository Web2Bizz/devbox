import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../../../../../common/logger';

export type CloneStatus = 'queued' | 'cloning' | 'ready' | 'failed';

export type CloneJob = {
  userId: string;
  userSpace: string;
  repoName: string;
  /** Sanitized repo URL (credentials masked by AppLogger on the way out). */
  repoUrl: string;
  status: CloneStatus;
  progress: number;
  error: string | null;
  updatedAt: string;
};

const TERMINAL_READY: CloneStatus = 'ready';

/**
 * CloneJobsRepository — MVP in-memory clone-job store (boots without
 * postgres, like ProjectsService / GithubInstallationsService).
 *
 * Jobs live only in this process: there is no `clone_jobs` table and no
 * migration for one yet, so a restart drops every job. The store stays keyed
 * by (userId, repoName) so a later drizzle-backed implementation can swap in
 * without changing the service surface.
 *
 * Keyed by (userId, repoName): the same repo name owned by two users yields
 * two independent jobs (per-user isolation); per-key promise locks make
 * concurrent `clone()` calls idempotent instead of racing.
 */
@Injectable()
export class CloneJobsRepository {
  private readonly jobs = new Map<string, CloneJob>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly logger: AppLogger = new AppLogger(CloneJobsRepository.name)) {}

  key(userId: string, repoName: string): string {
    return `${userId}::${repoName}`;
  }

  get(userId: string, repoName: string): CloneJob | null {
    return this.jobs.get(this.key(userId, repoName)) ?? null;
  }

  /** Idempotent enqueue: queued/cloning/ready jobs are returned as-is (never reset). */
  enqueue(input: {
    userId: string;
    userSpace: string;
    repoName: string;
    repoUrl: string;
  }): { job: CloneJob; created: boolean } {
    const key = this.key(input.userId, input.repoName);
    const prev = this.jobs.get(key);
    if (prev && prev.status !== 'failed') {
      return { job: prev, created: false };
    }
    const now = new Date().toISOString();
    const job: CloneJob = {
      userId: input.userId,
      userSpace: input.userSpace,
      repoName: input.repoName,
      repoUrl: input.repoUrl,
      status: 'queued',
      progress: 0,
      error: null,
      updatedAt: now,
    };
    this.jobs.set(key, job);
    this.logger.info(`[workspaces] clone queued ${input.userSpace}/${input.repoName}`);
    return { job, created: true };
  }

  transition(userId: string, repoName: string, status: CloneStatus, patch?: Partial<CloneJob>): CloneJob | null {
    const key = this.key(userId, repoName);
    const prev = this.jobs.get(key);
    if (!prev) return null;
    const next: CloneJob = {
      ...prev,
      ...patch,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(key, next);
    return next;
  }

  markCloning(userId: string, repoName: string): CloneJob | null {
    return this.transition(userId, repoName, 'cloning', { progress: 10, error: null });
  }

  markProgress(userId: string, repoName: string, progress: number): CloneJob | null {
    return this.transition(userId, repoName, this.get(userId, repoName)?.status ?? 'cloning', {
      progress,
    });
  }

  markReady(userId: string, repoName: string): CloneJob | null {
    return this.transition(userId, repoName, TERMINAL_READY, { progress: 100, error: null });
  }

  markFailed(userId: string, repoName: string, error: string): CloneJob | null {
    return this.transition(userId, repoName, 'failed', { error, progress: 0 });
  }

  /** Runs `task` serialized per (userId, repoName) — concurrent clones of the same repo collapse. */
  async withLock<T>(userId: string, repoName: string, task: () => Promise<T>): Promise<T> {
    const key = this.key(userId, repoName);
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const own = prev.then(() => current);
    this.locks.set(key, own);
    await prev;
    try {
      return await task();
    } finally {
      release();
      // Only the tail of the chain owns the key: a newer job may have enqueued
      // behind us (then it will clean up), and re-running the same key after
      // completion must start a fresh chain.
      if (this.locks.get(key) === own) this.locks.delete(key);
    }
  }

  /** Test/e2e seam — drops the whole in-memory registry. */
  clearAllForTests(): void {
    this.jobs.clear();
    this.locks.clear();
  }
}
