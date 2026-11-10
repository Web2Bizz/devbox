import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { throwStorageNotConfigured } from './storage-unavailable';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { uuidSchema } from '../validation';

/**
 * Minimal dirent shape for `readDir()` listings (structural subset of
 * `Dirent`, so the fs primitive stays the only fs import outside this file).
 */
export type DirEntry = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export type ProjectScope = 'user' | 'org';

export type OrgScopeResolved = {
  /** Org id (validated uuid). */
  orgId: string;
  /** Absolute org home: <root>/orgs/<orgId>. */
  absoluteHome: string;
  /** Absolute org-level reserved secrets dir (empty, never served). */
  absoluteSecrets: string;
};

export type ProjectResolved = {
  /** 'org' → orgs/<uuid>/… (no workspace segment; user homes removed). */
  scope: ProjectScope;
  /** Scope owner id (org uuid, as passed — validated uuid). */
  scopeId: string;
  /** Project id (validated uuid). */
  projectId: string;
  /** Absolute project home: <root>/orgs/<scopeId>/projects/<projectId>. */
  absoluteBase: string;
  /** Absolute content root: <absoluteBase>/content (git repo lives here). */
  absoluteRepo: string;
  /** Absolute reserved secrets dir: <absoluteBase>/.secrets (empty, never served). */
  absoluteSecrets: string;
  /** Absolute scope-level reserved secrets dir (empty, never served). */
  scopeSecrets: string;
  /** Absolute jailed target (content root or nested subPath inside it). */
  absolutePath: string;
  /** Normalized posix-relative path inside content ('.' for root). */
  relativePath: string;
};

/** Removal flags for `removeDir()` (both default to true). */
export type RemoveDirOptions = {
  recursive?: boolean;
  force?: boolean;
};

/**
 * WorkspacePathService — scoped path jail for projects (organizations epic).
 *
 * SCOPE: Common — lives in common/storage (503 gate + jail), stateless and
 * provided directly (no WorkspacesModule dependency).
 *
 * Canonical layout on disk (REPOS_ROOT, strict, БЕЗ сегмента `workspace`):
 *   orgs/<org_uuid>/projects/<project_uuid>/{content,.secrets}
 *   orgs/<org_uuid>/.secrets
 *
 * User homes (users/<user_uuid>/…) are removed (org-only model): path
 * resolution is org-scoped only.
 *
 * - `resolveOrg(orgId, projectId, sub?)` (+ `*Strict` write variant)
 *   validates every id as uuid (400 on garbage) and jails the result (403 on traversal): `..`, absolute paths,
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
 * - SINGLE JAIL for fs: `ensureDir/removeDir/statPath/readDir` are thin
 *   primitives on paths the caller already resolved through this jail, so
 *   projects/files/organizations/repository never import `node:fs`
 *   themselves (gate: `grep -rn "node:fs" src` outside this file).
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
    const reposRoot: string = (process.env.REPOS_ROOT ?? '').trim();
    if (!reposRoot) throwStorageNotConfigured('workspaces.resolveRoot');
    return path.resolve(reposRoot);
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
    const reposRoot: string = (process.env.REPOS_ROOT ?? '').trim();
    if (!reposRoot) {
      throw new InternalServerErrorException(
        'Project storage is not configured (REPOS_ROOT is empty)',
      );
    }
    return path.resolve(reposRoot);
  }

  /** Realpath of the strict root (falls back to lexical when missing). */
  async realStrictRoot(): Promise<string> {
    const root: string = this.requireExplicitRoot();
    try {
      return await realpath(root);
    } catch {
      return root;
    }
  }

  /** Realpath of the jail root (falls back to the lexical root when missing). */
  async realRoot(): Promise<string> {
    const root: string = this.resolveRoot();
    try {
      return await realpath(root);
    } catch {
      return root;
    }
  }

  /**
   * Throws 403 when `absolutePath` escapes `jailReal` (symlink-aware when the path
   * exists, lexical otherwise). Never throws for paths inside.
   */
  async assertInsideJail(absolutePath: string, jailReal: string): Promise<string> {
    let real: string = absolutePath;
    try {
      real = await realpath(absolutePath);
    } catch {
      // Missing target (e.g. fresh clone dest) — lexical check only.
    }
    const jailWithSeparator: string = jailReal.endsWith(path.sep)
      ? jailReal
      : jailReal + path.sep;
    if (real !== jailReal && !real.startsWith(jailWithSeparator)) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    return real;
  }

  /**
   * fs primitives — the SINGLE jail rule for disk access outside
   * common/storage (CoC: repository is the only other place allowed to touch
   * fs). Every method here is a thin, behaviour-preserving wrapper: the
   * CALLER passes a path already validated by the jail
   * (`resolveOrg`/`ensureProjectDirs`…), these helpers do NO
   * path validation and NO storage-config gate of their own.
   */

  /** `mkdir -p` for a jailed path (recursive, idempotent). */
  async ensureDir(absolutePath: string): Promise<void> {
    await mkdir(absolutePath, { recursive: true });
  }

  /**
   * Remove a jailed path. Defaults are `recursive: true, force: true` — the
   * same semantics as the previous direct `rm(absolutePath, { recursive, force })`
   * call sites (missing path is not an error).
   */
  async removeDir(
    absolutePath: string,
    options?: RemoveDirOptions,
  ): Promise<void> {
    await rm(absolutePath, {
      recursive: options?.recursive ?? true,
      force: options?.force ?? true,
    });
  }

  /**
   * `stat` for a jailed path: missing target (`ENOENT`) → `null`, any other
   * error (EACCES, ENOTDIR parent, …) is rethrown as-is.
   */
  async statPath(absolutePath: string): Promise<Stats | null> {
    try {
      return await stat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** `readdir` with dirents (names + type predicates) for a jailed path. */
  async readDir(absolutePath: string): Promise<Array<DirEntry>> {
    return readdir(absolutePath, { withFileTypes: true });
  }

  /**
   * `readFile` (utf8) for a jailed path: the CALLER passes a path already
   * validated by the jail (`resolveOrg`/`resolveOrgStrict` + lexical prefix
   * against the project content dir), this helper does NO path validation
   * of its own — same contract as `ensureDir`/`statPath`/`readDir` above.
   */
  async readFile(absolutePath: string): Promise<string> {
    return readFile(absolutePath, 'utf8');
  }

  /**
   * `writeFile` (utf8, overwrite) for a jailed path: same caller-validated
   * contract as `readFile` — no validation and no storage-config gate here.
   */
  async writeFile(absolutePath: string, content: string): Promise<void> {
    await writeFile(absolutePath, content, 'utf8');
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
   * 400 on garbage (empty, non-uuid) — never a jail escape via a crafted id
   * segment.
   */
  checkUuid(value: unknown, label: string): string {
    const rawValue: string = String(value ?? '').trim();
    if (!rawValue || !uuidSchema.safeParse(rawValue).success) {
      throw new BadRequestException(`${label} must be a uuid`);
    }
    return rawValue.toLowerCase();
  }

  /** Shared sub-path validation (same traversal rules as `resolve()`). */
  private checkSubRel(subPath?: string): string {
    const rawSubPath: string = subPath ?? '.';
    if (rawSubPath.includes('\0')) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    const decoded: string = this.decodeOnce(String(rawSubPath));
    if (decoded.includes('\0')) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    if (path.isAbsolute(decoded)) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    const relative: string =
      path.posix.normalize(decoded.replace(/\\/g, '/').replace(/^\/+/, '')) || '.';
    if (
      relative === '..' ||
      relative.startsWith('../') ||
      relative.includes('/../') ||
      relative.endsWith('/..')
    ) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    return relative;
  }

  private async resolveScoped(
    scope: ProjectScope,
    root: string,
    rootReal: string,
    scopeId: string,
    projectId: string,
    subPath?: string,
  ): Promise<ProjectResolved> {
    const scopeSegment: string = scope === 'user' ? 'users' : 'orgs';
    const absoluteBase: string = path.resolve(
      root,
      scopeSegment,
      scopeId,
      'projects',
      projectId,
    );
    // Project home itself must stay inside the jail (lexical + symlink-aware).
    await this.assertInsideJail(absoluteBase, rootReal);
    const absoluteRepo: string = path.join(absoluteBase, 'content');
    const absoluteSecrets: string = path.join(absoluteBase, '.secrets');
    const scopeSecrets: string = path.resolve(root, scopeSegment, scopeId, '.secrets');
    await this.assertInsideJail(scopeSecrets, rootReal);

    const relativePath: string = this.checkSubRel(subPath);
    const absoluteLexical: string =
      relativePath === '.' ? absoluteRepo : path.resolve(absoluteRepo, relativePath);
    let contentReal: string = absoluteRepo;
    try {
      contentReal = await realpath(absoluteRepo);
    } catch {
      // Content missing yet (pre-create) — lexical content jail still applies.
    }
    const absolutePath: string = await this.assertInsideJail(absoluteLexical, contentReal);
    // Belt-and-braces: lexical prefix against the content dir too (covers
    // not-yet-existing nested paths where realpath fell through).
    const contentWithSeparator: string = absoluteRepo.endsWith(path.sep)
      ? absoluteRepo
      : absoluteRepo + path.sep;
    if (
      absoluteLexical !== absoluteRepo &&
      !absoluteLexical.startsWith(contentWithSeparator)
    ) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    return {
      scope,
      scopeId,
      projectId,
      absoluteBase,
      absoluteRepo,
      absoluteSecrets,
      scopeSecrets,
      absolutePath,
      relativePath,
    };
  }

  /**
   * Resolve + jail `REPOS_ROOT/orgs/<orgUuid>/projects/<projectUuid>/content[/subPath]`.
   * Storage gate first (503 when REPOS_ROOT empty), then uuid 400s, then
   * traversal 403s. `.secrets` siblings are never addressable: `sub` is
   * always anchored under `content`.
   *
   * User-space resolution (`users/<userUuid>/…`) was removed with the
   * org-only model — use `resolveOrg` for every project home.
   */
  async resolveOrg(
    orgId: string,
    projectId: string,
    subPath?: string,
  ): Promise<ProjectResolved> {
    const root: string = this.resolveRoot();
    const rootReal: string = await this.realRoot();
    const validatedOrgId: string = this.checkUuid(orgId, 'orgId');
    const validatedProjectId: string = this.checkUuid(projectId, 'projectId');
    return this.resolveScoped(
      'org',
      root,
      rootReal,
      validatedOrgId,
      validatedProjectId,
      subPath,
    );
  }

  /**
   * Strict write variant of `resolveOrg()` — same validation/jail, rooted
   * at `requireExplicitRoot()` (empty REPOS_ROOT → 500 before anything else).
   *
   * User-space resolution (`users/<userUuid>/…`) was removed with the
   * org-only model — use `resolveOrgStrict` for every project write.
   */
  async resolveOrgStrict(
    orgId: string,
    projectId: string,
    subPath?: string,
  ): Promise<ProjectResolved> {
    const root: string = this.requireExplicitRoot();
    const rootReal: string = await this.realStrictRoot();
    const validatedOrgId: string = this.checkUuid(orgId, 'orgId');
    const validatedProjectId: string = this.checkUuid(projectId, 'projectId');
    return this.resolveScoped(
      'org',
      root,
      rootReal,
      validatedOrgId,
      validatedProjectId,
      subPath,
    );
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
    const jailReal: string = await this.realStrictRoot();
    await this.assertInsideJail(resolved.absoluteBase, jailReal);
    await this.assertInsideJail(resolved.absoluteRepo, jailReal);
    await this.assertInsideJail(resolved.absoluteSecrets, jailReal);
    await this.assertInsideJail(resolved.scopeSecrets, jailReal);
    await mkdir(resolved.absoluteRepo, { recursive: true });
    await mkdir(resolved.absoluteSecrets, { recursive: true });
    await mkdir(resolved.scopeSecrets, { recursive: true });
  }

  /**
   * Strict resolve of the org home (`<root>/orgs/<orgId>` + `.secrets`).
   * Empty REPOS_ROOT → 500 before anything else; non-uuid orgId → 400.
   */
  async orgScopeStrict(orgId: string): Promise<OrgScopeResolved> {
    const root: string = this.requireExplicitRoot();
    const rootReal: string = await this.realStrictRoot();
    const validatedOrgId: string = this.checkUuid(orgId, 'orgId');
    const absoluteHome: string = path.resolve(root, 'orgs', validatedOrgId);
    const absoluteSecrets: string = path.join(absoluteHome, '.secrets');
    await this.assertInsideJail(absoluteHome, rootReal);
    await this.assertInsideJail(absoluteSecrets, rootReal);
    return { orgId: validatedOrgId, absoluteHome, absoluteSecrets };
  }

  /**
   * Disk-first `mkdir -p` for an org home: creates `orgs/<orgId>` plus the
   * empty reserved `.secrets` dir. Re-asserts the strict jail first.
   */
  async ensureOrgScope(orgId: string): Promise<OrgScopeResolved> {
    const scoped: OrgScopeResolved = await this.orgScopeStrict(orgId);
    const jailReal: string = await this.realStrictRoot();
    await this.assertInsideJail(scoped.absoluteHome, jailReal);
    await this.assertInsideJail(scoped.absoluteSecrets, jailReal);
    await mkdir(scoped.absoluteHome, { recursive: true });
    await mkdir(scoped.absoluteSecrets, { recursive: true });
    return scoped;
  }
}
