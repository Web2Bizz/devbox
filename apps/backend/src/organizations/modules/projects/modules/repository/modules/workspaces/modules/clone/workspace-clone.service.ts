import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { promisify } from 'node:util';
import { AppLogger } from '@common/logger';
import { validateEnv } from '@common/env/env';
import { ExternalServiceError } from '@common/external/external-error';
import { storageUnavailable } from '@common/storage/storage-unavailable';
import type { ProjectResolved } from '@common/storage/workspace-path.service';
import { isValidGitRepo, type GitCheck } from '../../../../utils/repos-git';
import { CloneJobsRepository, type CloneJob } from './clone-jobs.repository';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { readSubmodules } from '../../../../utils/submodules';
import {
  buildGitCloneArgs,
  createAllowedCloneHosts,
  normalizeRepoUrl,
} from './utils/repo-url';

type ExecFileAsync = (
  file: string,
  args: Array<string>,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileAsync = promisify(execFile);

/** Per-attempt budget for clone + submodule init (no shell, no secrets in logs). */
export const CLONE_TIMEOUT_MS: number = 120000;

function sanitizeForLog(value: string): string {
  return value.replace(/:\/\/([^/\s:@]+)(:[^/\s@]*)?@/g, '://***:***@');
}

/**
 * Allow-list host set resolved ONCE from the validated AppEnv (single source:
 * AppEnv.cloneAllowedHosts, filled at boot by CLONE_ALLOWED_HOSTS validation)
 * and cached, never rebuilt per clone call.
 */
let allowedCloneHostsCache: Set<string> | null = null;

function allowedCloneHosts(): Set<string> {
  if (!allowedCloneHostsCache) {
    allowedCloneHostsCache = createAllowedCloneHosts(validateEnv(process.env).cloneAllowedHosts);
  }
  return allowedCloneHostsCache;
}

async function dirIsEmpty(absolutePath: string): Promise<boolean> {
  try {
    const entries: Array<string> = await readdir(absolutePath);
    return entries.length === 0;
  } catch {
    return true; // missing → treated as empty (clone will create it)
  }
}

/**
 * WorkspaceCloneService — idempotent org-scoped `git clone` lifecycle.
 *
 * Dest is the project content dir
 * (orgs/<orgUuid>/projects/<projectUuid>/content): both ids are
 * uuid-validated (400 on garbage), the jail rules match
 * WorkspacePathService.resolveOrg (403 on traversal), and empty
 * REPOS_ROOT denies with 503 before any mkdir/clone.
 * - Lock + job key is (orgId, projectId): two scopes cloning into different
 *   project homes never touch each other's directory; repeat calls while
 *   queued/cloning/ready return the existing job (never re-clone over it).
 * - Clone runs `git clone --recurse-submodules -- <url> <dest>` + `git submodule
 *   update --init --recursive` via execFile (no shell); transitions
 *   queued → cloning → ready/failed with progress hints and AppLogger
 *   entries (URLs sanitized, no tokens/keys; logs carry ids only).
 * - A failed job may be re-queued by calling `clone()` again.
 *
 * User homes (users/<userUuid>/…) are removed (org-only model): the
 * (userId, repoName) args are the org id + project id of the project home.
 */
@Injectable()
export class WorkspaceCloneService {
  constructor(
    private readonly paths: WorkspacePathService,
    private readonly jobs: CloneJobsRepository,
    private readonly logger: AppLogger = new AppLogger(WorkspaceCloneService.name),
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
    let resolved: ProjectResolved;
    try {
      // uuid-validated org scope + project-bound dest (400 on garbage);
      // empty REPOS_ROOT denies with 503 before any mkdir/clone.
      resolved = await this.paths.resolveOrg(userId, repoName);
    } catch (error) {
      if (error instanceof ExternalServiceError && error.code === 'EXTERNAL_UNAVAILABLE') {
        storageUnavailable('workspaces.clone', this.logger, correlationId, error);
      }
      throw error;
    }
    const scopeId: string = resolved.scopeId;
    const projectId: string = resolved.projectId;
    await this.paths.assertInsideJail(resolved.absoluteRepo, await this.paths.realStrictRoot());
    // Storage/jail gates precede the URL allow-list (an unconfigured REPOS_ROOT
    // stays an honest 503), and only the normalized value travels to git.
    const url: string = normalizeRepoUrl(repoUrl, allowedCloneHosts());
    return this.jobs.withLock(scopeId, projectId, async () => {
      // Destructuring the enqueue result — explicit annotation cannot be expressed here.
      const { job, created } = this.jobs.enqueue({
        userId: scopeId,
        userSpace: scopeId,
        repoName: projectId,
        repoUrl: url,
      });
      // NOTE: enqueue keyed on the normalized (orgUuid, projectUuid) pair.
      void this.runClone(scopeId, job.repoName, url, resolved.absoluteRepo, created);
      return this.jobs.get(scopeId, job.repoName) ?? job;
    });
  }

  private async runClone(
    userId: string,
    repoName: string,
    repoUrl: string,
    absoluteDestination: string,
    created: boolean,
  ): Promise<void> {
    const current: CloneJob | null = this.jobs.get(userId, repoName);
    if (!current) return;
    if (!created && current.status === 'ready') return; // idempotent: keep ready
    if (!created && (current.status === 'queued' || current.status === 'cloning')) {
      return; // a run is already in flight for this key
    }
    this.jobs.markCloning(userId, repoName);
    this.logger.info(
      `[workspaces] cloning ${sanitizeForLog(repoUrl)} → orgs/${userId}/projects/${repoName}`,
    );
    try {
      // Fast path: dest already holds a valid repo (manual drop or retry) → ready.
      const existing: GitCheck = await isValidGitRepo(absoluteDestination);
      if (existing.ok) {
        this.jobs.markReady(userId, repoName);
        this.logger.info(`[workspaces] clone ready (exists) orgs/${userId}/projects/${repoName}`);
        return;
      }
      const empty: boolean = await dirIsEmpty(absoluteDestination);
      if (!empty && !existing.ok) {
        throw new Error('destination exists and is not an empty directory');
      }
      await mkdir(absoluteDestination, { recursive: true });
      this.jobs.markProgress(userId, repoName, 30);
      await execFileAsync('git', buildGitCloneArgs(repoUrl, absoluteDestination), {
        timeout: CLONE_TIMEOUT_MS,
      });
      this.jobs.markProgress(userId, repoName, 80);
      try {
        await execFileAsync('git', ['submodule', 'update', '--init', '--recursive'], {
          cwd: absoluteDestination,
          timeout: CLONE_TIMEOUT_MS,
        });
      } catch (submoduleError) {
        // Submodule init is best-effort: the clone itself succeeded.
        this.logger.warn(
          `[workspaces] submodule init skipped for orgs/${userId}/projects/${repoName}: ${(submoduleError as Error).message}`,
        );
      }
      await readSubmodules(absoluteDestination, this.logger).catch(() => []);
      this.jobs.markReady(userId, repoName);
      this.logger.info(`[workspaces] clone ready orgs/${userId}/projects/${repoName}`);
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      this.jobs.markFailed(userId, repoName, message.slice(0, 500));
      // Terminal failure of the clone operation → error (not warn):
      // the job settled on 'failed' and the caller must retry.
      this.logger.error(
        `[workspaces] clone failed orgs/${userId}/projects/${repoName}: ${sanitizeForLog(message).slice(0, 200)}`,
      );
      try {
        // Best-effort cleanup of half-cloned dest (never outside the jail —
        // absoluteDestination came from WorkspacePathService.resolveOrg).
        const stats: Stats | null = await stat(absoluteDestination).catch(() => null);
        if (stats && !(await isValidGitRepo(absoluteDestination)).ok) {
          const { rm } = await import('node:fs/promises');
          await rm(absoluteDestination, { recursive: true, force: true });
        }
      } catch {
        // Cleanup failure must not mask the failed status.
      }
    }
  }
}
