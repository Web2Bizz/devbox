import { BadRequestException, Injectable } from '@nestjs/common';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppLogger } from '../common/app-logger.service.js';
import {
  storageUnavailable,
  throwStorageNotConfigured,
} from '../storage/storage-unavailable.js';
import { userSpaceSchema, type ReposQuery } from './dto.js';
import { isValidGitRepo } from './repos-git.util.js';

export interface RepoEntry {
  /** Scope owner id (user uuid under users/, org uuid under orgs/). */
  userSpace: string;
  /** Project id (uuid). */
  name: string;
  /** Path relative to REPOS_ROOT, e.g. "users/<uuid>/projects/<uuid>/content". */
  path: string;
  updatedAt: string;
}

interface Candidate {
  scope: 'users' | 'orgs';
  userSpace: string;
  name: string;
  absPath: string;
  updatedAt: string;
}

const SCOPE_DIR_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Unified storage catalog over the organizations layout:
 *   users/<user-uuid>/projects/<project-uuid>/content
 *   orgs/<org-uuid>/projects/<project-uuid>/content
 * (no `workspace` segment; pre-epic data is hand-migrated per
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
  constructor(private readonly logger: AppLogger = new AppLogger('ReposService')) {}

  /**
   * Unified jail root — REPOS_ROOT only, no fallback. Empty REPOS_ROOT →
   * 503 EXTERNAL_UNAVAILABLE (storage-unconfigured deny, never a silent
   * <cwd>/repos read). Jail/traversal checks run after this gate.
   */
  resolveRoot(): string {
    const repos = (process.env.REPOS_ROOT ?? '').trim();
    if (!repos) throwStorageNotConfigured('repos.resolveRoot');
    return path.resolve(repos);
  }

  private async realRoot(): Promise<string> {
    const root = this.resolveRoot();
    try {
      return await realpath(root);
    } catch {
      return root;
    }
  }

  /** Jailed absolute path for a repo candidate (throws 400 on traversal). */
  private async jailCandidate(rootReal: string, rel: string): Promise<string> {
    const abs = path.resolve(this.resolveRoot(), rel);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      real = abs;
    }
    const withSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(withSep)) {
      throw new BadRequestException('Path traversal is forbidden');
    }
    return real;
  }

  /**
   * Scoped scan: root → (users|orgs) → <scope-uuid> → projects →
   * <project-uuid> → content. `.secrets` reserves are never candidates.
   */
  private async scan(userSpace?: string, correlationId?: string): Promise<Candidate[]> {
    let root: string;
    try {
      root = this.resolveRoot();
    } catch (err) {
      // Unconfigured storage → single deny log line, then the 503 propagates
      // (ApiErrorFilter → EXTERNAL_UNAVAILABLE + Retry-After 30). Never a
      // silent [] over <cwd>/repos.
      storageUnavailable('repos.list', this.logger, correlationId, err);
    }
    const rootReal = await this.realRoot();
    let scopes;
    try {
      scopes = await readdir(root, { withFileTypes: true });
    } catch {
      // Configured-but-missing/unreadable root → empty registry, never 500.
      // (Unconfigured REPOS_ROOT never reaches here — denied above with 503.)
      return [];
    }
    const out: Candidate[] = [];
    const wanted = userSpace?.trim();
    for (const s of scopes.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!s.isDirectory()) continue;
      if (s.name !== 'users' && s.name !== 'orgs') continue;
      let owners;
      try {
        owners = await readdir(path.join(root, s.name), { withFileTypes: true });
      } catch {
        continue; // no scope entries yet — skip (not an error)
      }
      for (const o of owners.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!o.isDirectory() || o.name.startsWith('.')) continue;
        if (!SCOPE_DIR_PATTERN.test(o.name)) continue;
        if (wanted && o.name !== wanted) continue;
        let projects;
        try {
          projects = await readdir(path.join(root, s.name, o.name, 'projects'), {
            withFileTypes: true,
          });
        } catch {
          continue; // scope without projects → skip (not an error)
        }
        for (const p of projects.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!p.isDirectory() || p.name.startsWith('.')) continue;
          const rel = path.join(s.name, o.name, 'projects', p.name, 'content');
          const abs = await this.jailCandidate(rootReal, rel);
          let mtime = new Date(0);
          try {
            const st = await stat(abs);
            if (!st.isDirectory()) continue;
            mtime = st.mtime;
          } catch {
            continue;
          }
          out.push({
            scope: s.name as 'users' | 'orgs',
            userSpace: o.name,
            name: p.name,
            absPath: abs,
            updatedAt: mtime.toISOString(),
          });
        }
      }
    }
    return out;
  }

  async list(
    userSpace?: string,
    query?: ReposQuery,
    correlationId?: string,
  ): Promise<RepoEntry[]> {
    if (userSpace !== undefined) {
      const parsed = userSpaceSchema.safeParse(userSpace);
      if (!parsed.success) {
        throw new BadRequestException(
          parsed.error.issues[0]?.message ?? 'Invalid userSpace',
        );
      }
    }
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const q = (query?.q ?? '').trim().toLowerCase();

    const candidates = await this.scan(userSpace, correlationId);
    const valid: RepoEntry[] = [];
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const check = await isValidGitRepo(c.absPath, this.logger);
      if (!check.ok) continue; // no-git/corrupted → skip, never 500
      if (q && !c.name.toLowerCase().includes(q)) continue;
      valid.push({
        userSpace: c.userSpace,
        name: c.name,
        path: `${c.scope}/${c.userSpace}/projects/${c.name}/content`,
        updatedAt: c.updatedAt,
      });
    }
    valid.sort((a, b) =>
      a.userSpace === b.userSpace
        ? a.name.localeCompare(b.name)
        : a.userSpace.localeCompare(b.userSpace),
    );
    return valid.slice(offset, offset + limit);
  }
}
