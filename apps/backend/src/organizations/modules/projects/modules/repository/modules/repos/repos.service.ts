import { BadRequestException, Injectable } from '@nestjs/common';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { AppLogger } from '@common/logger';
import {
  storageUnavailable,
  throwStorageNotConfigured,
} from '@common/storage/storage-unavailable';
import { userSpaceSchema, type ReposQuery } from './repos.dto';
import { isValidGitRepo, type GitCheck } from '../../utils/repos-git';

export type RepoEntry = {
  /** Scope owner id (org uuid under orgs/). */
  userSpace: string;
  /** Project id (uuid). */
  name: string;
  /** Path relative to REPOS_ROOT, e.g. "orgs/<uuid>/projects/<uuid>/content". */
  path: string;
  updatedAt: string;
};

type Candidate = {
  scope: 'orgs';
  userSpace: string;
  name: string;
  absolutePath: string;
  updatedAt: string;
};

const SCOPE_DIR_PATTERN: RegExp = /^[a-zA-Z0-9_-]+$/;

/**
 * Unified storage catalog over the org layout:
 *   orgs/<org-uuid>/projects/<project-uuid>/content
 * (no `workspace` segment; user homes users/<uuid>/… are not scanned —
 * org-only model; pre-epic data is hand-migrated per
 * docs/manual-migration-orgs-layout.md).
 *
 * READ ONLY: only `readdir`/`stat`/`realpath` (never recurses into a repo),
 * git validation lives in repos-git.util (execFile, no shell). No clone, no
 * write, no network. `.secrets` reserves are never listed. Every candidate
 * is realpath-resolved and jailed inside the root; corrupted repos are
 * skipped with `logger.warn` ({ path, reason }) and never produce a 500
 * for the whole listing.
 *
 * Unified deny: REPOS_ROOT is the SINGLE source for reads AND writes.
 * Empty REPOS_ROOT → 503 EXTERNAL_UNAVAILABLE (Retry-After 30 via
 * ApiErrorFilter, logged once with the correlationId) — never silently read
 * <cwd>/repos, never answer a quiet [].
 */
@Injectable()
export class ReposService {
  constructor(private readonly logger: AppLogger = new AppLogger(ReposService.name)) {}

  /**
   * Unified jail root — REPOS_ROOT only, no fallback. Empty REPOS_ROOT →
   * 503 EXTERNAL_UNAVAILABLE (storage-unconfigured deny, never a silent
   * <cwd>/repos read). Jail/traversal checks run after this gate.
   */
  resolveRoot(): string {
    const repos: string = (process.env.REPOS_ROOT ?? '').trim();
    if (!repos) throwStorageNotConfigured('repos.resolveRoot');
    return path.resolve(repos);
  }

  private async realRoot(): Promise<string> {
    const root: string = this.resolveRoot();
    try {
      return await realpath(root);
    } catch {
      return root;
    }
  }

  /** Jailed absolute path for a repo candidate (throws 400 on traversal). */
  private async jailCandidate(rootReal: string, relativePath: string): Promise<string> {
    const absolutePath: string = path.resolve(this.resolveRoot(), relativePath);
    let real: string;
    try {
      real = await realpath(absolutePath);
    } catch {
      real = absolutePath;
    }
    const withSeparator: string = rootReal.endsWith(path.sep)
      ? rootReal
      : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(withSeparator)) {
      throw new BadRequestException('Path traversal is forbidden');
    }
    return real;
  }

  /**
   * Org-scoped scan: root → orgs → <org-uuid> → projects →
   * <project-uuid> → content. `.secrets` reserves are never candidates.
   */
  private async scan(userSpace?: string, correlationId?: string): Promise<Array<Candidate>> {
    let root: string;
    try {
      root = this.resolveRoot();
    } catch (error) {
      // Unconfigured storage → single deny log line, then the 503 propagates
      // (ApiErrorFilter → EXTERNAL_UNAVAILABLE + Retry-After 30). Never a
      // silent [] over <cwd>/repos.
      storageUnavailable('repos.list', this.logger, correlationId, error);
    }
    const rootReal: string = await this.realRoot();
    let scopes: Array<Dirent>;
    try {
      scopes = await readdir(root, { withFileTypes: true });
    } catch {
      // Configured-but-missing/unreadable root → empty registry, never 500.
      // (Unconfigured REPOS_ROOT never reaches here — denied above with 503.)
      return [];
    }
    const candidates: Array<Candidate> = [];
    const wanted: string | undefined = userSpace?.trim();
    for (const scopeEntry of scopes.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!scopeEntry.isDirectory()) continue;
      if (scopeEntry.name !== 'orgs') continue;
      let owners: Array<Dirent>;
      try {
        owners = await readdir(path.join(root, scopeEntry.name), { withFileTypes: true });
      } catch {
        continue; // no scope entries yet — skip (not an error)
      }
      for (const ownerEntry of owners.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!ownerEntry.isDirectory() || ownerEntry.name.startsWith('.')) continue;
        if (!SCOPE_DIR_PATTERN.test(ownerEntry.name)) continue;
        if (wanted && ownerEntry.name !== wanted) continue;
        let projects: Array<Dirent>;
        try {
          projects = await readdir(
            path.join(root, scopeEntry.name, ownerEntry.name, 'projects'),
            {
              withFileTypes: true,
            },
          );
        } catch {
          continue; // scope without projects → skip (not an error)
        }
        for (const projectEntry of projects.sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          if (!projectEntry.isDirectory() || projectEntry.name.startsWith('.')) continue;
          const relativePath: string = path.join(
            scopeEntry.name,
            ownerEntry.name,
            'projects',
            projectEntry.name,
            'content',
          );
          const absolutePath: string = await this.jailCandidate(rootReal, relativePath);
          let modifiedAt: Date = new Date(0);
          try {
            const stats: Stats = await stat(absolutePath);
            if (!stats.isDirectory()) continue;
            modifiedAt = stats.mtime;
          } catch {
            continue;
          }
          candidates.push({
            scope: 'orgs',
            userSpace: ownerEntry.name,
            name: projectEntry.name,
            absolutePath,
            updatedAt: modifiedAt.toISOString(),
          });
        }
      }
    }
    return candidates;
  }

  async list(
    userSpace?: string,
    query?: ReposQuery,
    correlationId?: string,
  ): Promise<Array<RepoEntry>> {
    if (userSpace !== undefined) {
      const parsed: z.ZodSafeParseResult<string> = userSpaceSchema.safeParse(userSpace);
      if (!parsed.success) {
        throw new BadRequestException(
          parsed.error.issues[0]?.message ?? 'Invalid userSpace',
        );
      }
    }
    const limit: number = query?.limit ?? 50;
    const offset: number = query?.offset ?? 0;
    const search: string = (query?.q ?? '').trim().toLowerCase();

    const candidates: Array<Candidate> = await this.scan(userSpace, correlationId);
    const valid: Array<RepoEntry> = [];
    for (const candidate of candidates) {
      const check: GitCheck = await isValidGitRepo(candidate.absolutePath, this.logger);
      if (!check.ok) continue; // no-git/corrupted → skip, never 500
      if (search && !candidate.name.toLowerCase().includes(search)) continue;
      valid.push({
        userSpace: candidate.userSpace,
        name: candidate.name,
        path: `${candidate.scope}/${candidate.userSpace}/projects/${candidate.name}/content`,
        updatedAt: candidate.updatedAt,
      });
    }
    valid.sort((left, right) =>
      left.userSpace === right.userSpace
        ? left.name.localeCompare(right.name)
        : left.userSpace.localeCompare(right.userSpace),
    );
    return valid.slice(offset, offset + limit);
  }
}
