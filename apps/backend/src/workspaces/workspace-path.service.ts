import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { throwStorageNotConfigured } from '../storage/storage-unavailable.js';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProjectScope = 'user' | 'org';

export interface OrgScopeResolved {
  /** Org id (validated uuid). */
  orgId: string;
  /** Absolute org home: <root>/orgs/<orgId>. */
  absHome: string;
  /** Absolute org-level reserved secrets dir (empty, never served). */
  absSecrets: string;
}

export interface ProjectResolved {
  /** 'user' → users/<uuid>/…, 'org' → orgs/<uuid>/… (no workspace segment). */
  scope: ProjectScope;
  /** Scope owner id (user uuid or org uuid, as passed — validated uuid). */
  scopeId: string;
  /** Project id (validated uuid). */
  projectId: string;
  /** Absolute project home: <root>/(users|orgs)/<scopeId>/projects/<projectId>. */
  absBase: string;
  /** Absolute content root: <absBase>/content (git repo lives here). */
  absRepo: string;
  /** Absolute reserved secrets dir: <absBase>/.secrets (empty, never served). */
  absSecrets: string;
  /** Absolute scope-level reserved secrets dir (empty, never served). */
  scopeSecrets: string;
  /** Absolute jailed target (content root or nested subPath inside it). */
  abs: string;
  /** Normalized posix-relative path inside content ('.' for root). */
  rel: string;
}

/**
 * WorkspacePathService — scoped path jail for projects (organizations epic).
 *
 * Canonical layout on disk (REPOS_ROOT, strict, БЕЗ сегмента `workspace`):
 *   users/<user_uuid>/projects/<project_uuid>/{content,.secrets}
 *   users/<user_uuid>/.secrets
 *   orgs/<org_uuid>/projects/<project_uuid>/{content,.secrets}
 *   orgs/<org_uuid>/.secrets
 *
 * - `resolveUser(userId, projectId, sub?)` / `resolveOrg(orgId, projectId,
 *   sub?)` (+ `*Strict` write variants) validate every id as uuid (400 on
 *   garbage) and jail the result (403 on traversal): `..`, absolute paths,
 *   URL-encoded escapes (`%2e%2e`, `%2f`), null bytes and symlinks pointing
 *   outside the jail are all rejected.
 * - Jail root: REPOS_ROOT only (unified catalog, single source for reads
 *   AND writes). Empty REPOS_ROOT → every lenient resolve denies with 503
 *   EXTERNAL_UNAVAILABLE (never a silent <cwd>/repos read, never []/404
 *   over an unconfigured root). Strict writes throw 500 instead — no silent
 *   fallback to <cwd>/repos for writes.
 * - Explicit-but-missing root policy: an explicitly set REPOS_ROOT that does
 *   not exist yet is NOT an error at resolve time — callers create it
 *   recursive (disk-first `mkdir -p`, same as `git init` dest). Only an
 *   EMPTY/whitespace REPOS_ROOT is unconfigured.
 * - `ensureProjectDirs()` (`mkdir -p`) creates `content` plus the empty
 *   reserved `.secrets` dirs (contents never committed, never served —
 *   `sub` is always anchored under `content`).
 * - Removed in the epic: legacy `userSpace()/resolve()/resolveStrict()`
 *   (frozen `<space>/workspace/<repo>` layout). Pre-epic on-disk data is
 *   moved by hand per docs/manual-migration-orgs-layout.md (no
 *   auto-migration code).
 */
@Injectable()
export class WorkspacePathService {
  /**
   * Unified jail root — REPOS_ROOT only, no fallback. Empty REPOS_ROOT →
   * 503 EXTERNAL_UNAVAILABLE (storage-unconfigured deny for every READ;
   * never silently read <cwd>/repos, never answer a quiet []/404 over an
   * unconfigured root). Write paths keep the 500 via requireExplicitRoot().
   */
  resolveRoot(): string {
    const repos = (process.env.REPOS_ROOT ?? '').trim();
    if (!repos) throwStorageNotConfigured('workspaces.resolveRoot');
    return path.resolve(repos);
  }

  /**
   * True when an explicit REPOS_ROOT is configured (non-empty after trim).
   * Projects writes require this; readonly registries do not.
   */
  isExplicitRootConfigured(): boolean {
    return (process.env.REPOS_ROOT ?? '').trim().length > 0;
  }

  /**
   * Strict jail root for project writes — REPOS_ROOT is the single canonical
   * source. Empty/whitespace REPOS_ROOT → 500 before any mkdir/INSERT so a
   * project is never silently created under <cwd>/repos.
   *
   * Explicit-but-missing root is OK (caller creates it recursive).
   */
  requireExplicitRoot(): string {
    const repos = (process.env.REPOS_ROOT ?? '').trim();
    if (!repos) {
      throw new InternalServerErrorException(
        'Project storage is not configured (REPOS_ROOT is empty)',
      );
    }
    return path.resolve(repos);
  }

  /** Realpath of the strict root (falls back to lexical when missing). */
  async realStrictRoot(): Promise<string> {
    const root = this.requireExplicitRoot();
    try {
      return await realpath(root);
    } catch {
      return root;
    }
  }

  /** Realpath of the jail root (falls back to the lexical root when missing). */
  async realRoot(): Promise<string> {
    const root = this.resolveRoot();
    try {
      return await realpath(root);
    } catch {
      return root;
    }
  }

  /**
   * Throws 403 when `abs` escapes `jailReal` (symlink-aware when the path
   * exists, lexical otherwise). Never throws for paths inside.
   */
  async assertInsideJail(abs: string, jailReal: string): Promise<string> {
    let real = abs;
    try {
      real = await realpath(abs);
    } catch {
      // Missing target (e.g. fresh clone dest) — lexical check only.
    }
    const withSep = jailReal.endsWith(path.sep) ? jailReal : jailReal + path.sep;
    if (real !== jailReal && !real.startsWith(withSep)) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    return real;
  }

  /** Decode once (`%2e%2e` → `..`) so encoded escapes are caught too. */
  private decodeOnce(input: string): string {
    if (!input.includes('%')) return input;
    try {
      return decodeURIComponent(input);
    } catch {
      throw new BadRequestException('Invalid URL-encoded path');
    }
  }

  /**
   * uuid shape check for the organizations layout (user/org/project ids).
   * 400 on garbage (empty, too long, non-uuid) — never a jail escape via
   * a crafted id segment.
   */
  checkUuid(value: unknown, label: string): string {
    const raw = String(value ?? '').trim();
    if (!raw || raw.length > 36 || !UUID_RE.test(raw)) {
      throw new BadRequestException(`${label} must be a uuid`);
    }
    return raw.toLowerCase();
  }

  /** Shared sub-path validation (same traversal rules as `resolve()`). */
  private checkSubRel(subPath?: string): string {
    const rawSub = subPath ?? '.';
    if (rawSub.includes('\0')) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    const decoded = this.decodeOnce(String(rawSub));
    if (decoded.includes('\0')) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    if (path.isAbsolute(decoded)) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    const rel = path.posix.normalize(decoded.replace(/\\/g, '/').replace(/^\/+/, '')) || '.';
    if (rel === '..' || rel.startsWith('../') || rel.includes('/../') || rel.endsWith('/..')) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    return rel;
  }

  private async resolveScoped(
    scope: ProjectScope,
    root: string,
    rootReal: string,
    scopeId: string,
    projectId: string,
    subPath?: string,
  ): Promise<ProjectResolved> {
    const seg = scope === 'user' ? 'users' : 'orgs';
    const absBase = path.resolve(root, seg, scopeId, 'projects', projectId);
    // Project home itself must stay inside the jail (lexical + symlink-aware).
    await this.assertInsideJail(absBase, rootReal);
    const absRepo = path.join(absBase, 'content');
    const absSecrets = path.join(absBase, '.secrets');
    const scopeSecrets = path.resolve(root, seg, scopeId, '.secrets');
    await this.assertInsideJail(scopeSecrets, rootReal);

    const rel = this.checkSubRel(subPath);
    const absLexical = rel === '.' ? absRepo : path.resolve(absRepo, rel);
    let contentReal = absRepo;
    try {
      contentReal = await realpath(absRepo);
    } catch {
      // Content missing yet (pre-create) — lexical content jail still applies.
    }
    const abs = await this.assertInsideJail(absLexical, contentReal);
    // Belt-and-braces: lexical prefix against the content dir too (covers
    // not-yet-existing nested paths where realpath fell through).
    const contentWithSep = absRepo.endsWith(path.sep) ? absRepo : absRepo + path.sep;
    if (absLexical !== absRepo && !absLexical.startsWith(contentWithSep)) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    return {
      scope,
      scopeId,
      projectId,
      absBase,
      absRepo,
      absSecrets,
      scopeSecrets,
      abs,
      rel,
    };
  }

  /**
   * Resolve + jail `REPOS_ROOT/users/<userUuid>/projects/<projectUuid>/content[/subPath]`.
   * Storage gate first (503 when REPOS_ROOT empty), then uuid 400s, then
   * traversal 403s. `.secrets` siblings are never addressable: `sub` is
   * always anchored under `content`.
   */
  async resolveUser(
    userId: string,
    projectId: string,
    subPath?: string,
  ): Promise<ProjectResolved> {
    const root = this.resolveRoot();
    const rootReal = await this.realRoot();
    const uid = this.checkUuid(userId, 'userId');
    const pid = this.checkUuid(projectId, 'projectId');
    return this.resolveScoped('user', root, rootReal, uid, pid, subPath);
  }

  /**
   * Resolve + jail `REPOS_ROOT/orgs/<orgUuid>/projects/<projectUuid>/content[/subPath]`.
   * Same gates as `resolveUser()` (503 → 400 → 403).
   */
  async resolveOrg(
    orgId: string,
    projectId: string,
    subPath?: string,
  ): Promise<ProjectResolved> {
    const root = this.resolveRoot();
    const rootReal = await this.realRoot();
    const oid = this.checkUuid(orgId, 'orgId');
    const pid = this.checkUuid(projectId, 'projectId');
    return this.resolveScoped('org', root, rootReal, oid, pid, subPath);
  }

  /**
   * Strict write variant of `resolveUser()` — same validation/jail, rooted
   * at `requireExplicitRoot()` (empty REPOS_ROOT → 500 before anything else).
   */
  async resolveUserStrict(
    userId: string,
    projectId: string,
    subPath?: string,
  ): Promise<ProjectResolved> {
    const root = this.requireExplicitRoot();
    const rootReal = await this.realStrictRoot();
    const uid = this.checkUuid(userId, 'userId');
    const pid = this.checkUuid(projectId, 'projectId');
    return this.resolveScoped('user', root, rootReal, uid, pid, subPath);
  }

  /**
   * Strict write variant of `resolveOrg()` — same validation/jail, rooted
   * at `requireExplicitRoot()` (empty REPOS_ROOT → 500 before anything else).
   */
  async resolveOrgStrict(
    orgId: string,
    projectId: string,
    subPath?: string,
  ): Promise<ProjectResolved> {
    const root = this.requireExplicitRoot();
    const rootReal = await this.realStrictRoot();
    const oid = this.checkUuid(orgId, 'orgId');
    const pid = this.checkUuid(projectId, 'projectId');
    return this.resolveScoped('org', root, rootReal, oid, pid, subPath);
  }

  /**
   * Disk-first `mkdir -p` for a scoped project home: creates `content`, the
   * project-level `.secrets` reserve and the scope-level `.secrets` reserve.
   * All dirs stay inside the strict jail (`resolved` must come from a
   * `*Strict` resolver); re-asserts the jail before the first write.
   * `.secrets` dirs stay empty (contents are never committed to git —
   * callers must not write tracked files there).
   */
  async ensureProjectDirs(resolved: ProjectResolved): Promise<void> {
    const jailReal = await this.realStrictRoot();
    await this.assertInsideJail(resolved.absBase, jailReal);
    await this.assertInsideJail(resolved.absRepo, jailReal);
    await this.assertInsideJail(resolved.absSecrets, jailReal);
    await this.assertInsideJail(resolved.scopeSecrets, jailReal);
    await mkdir(resolved.absRepo, { recursive: true });
    await mkdir(resolved.absSecrets, { recursive: true });
    await mkdir(resolved.scopeSecrets, { recursive: true });
  }

  /**
   * Strict resolve of the org home (`<root>/orgs/<orgId>` + `.secrets`).
   * Empty REPOS_ROOT → 500 before anything else; non-uuid orgId → 400.
   */
  async orgScopeStrict(orgId: string): Promise<OrgScopeResolved> {
    const root = this.requireExplicitRoot();
    const rootReal = await this.realStrictRoot();
    const oid = this.checkUuid(orgId, 'orgId');
    const absHome = path.resolve(root, 'orgs', oid);
    const absSecrets = path.join(absHome, '.secrets');
    await this.assertInsideJail(absHome, rootReal);
    await this.assertInsideJail(absSecrets, rootReal);
    return { orgId: oid, absHome, absSecrets };
  }

  /**
   * Disk-first `mkdir -p` for an org home: creates `orgs/<orgId>` plus the
   * empty reserved `.secrets` dir. Re-asserts the strict jail first.
   */
  async ensureOrgScope(orgId: string): Promise<OrgScopeResolved> {
    const scoped = await this.orgScopeStrict(orgId);
    const jailReal = await this.realStrictRoot();
    await this.assertInsideJail(scoped.absHome, jailReal);
    await this.assertInsideJail(scoped.absSecrets, jailReal);
    await mkdir(scoped.absHome, { recursive: true });
    await mkdir(scoped.absSecrets, { recursive: true });
    return scoped;
  }
}
