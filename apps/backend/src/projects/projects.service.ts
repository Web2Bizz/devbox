import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { AppLogger } from "../common/app-logger.service";
import { DbService, dbUnavailable, type DbClient } from "../db/db.service";
import { projects, type ProjectRow } from "../db/schema";
import { isValidGitRepo } from "../repos/repos-git.util";
import { WorkspacePathService } from "../workspaces/workspace-path.service";
import type {
  CreateProjectInput,
  GithubLinkInput,
  UpdateProjectInput,
} from "./dto";

const execFileAsync = promisify(execFile);

/** Per-command budget for `git init/config/commit` during disk-first create. */
const PROJECT_GIT_TIMEOUT_MS = 15000;

/**
 * Owner-less / legacy rows (ownerId NULL) map to this deterministic user
 * home: users/00000000-…/projects/<id>/content. A fixed nil-uuid keeps the
 * uuid-validated layout total (no `system` string segment anywhere).
 */
export const SYSTEM_OWNER_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Maps a stored ownerId to its user-home uuid. NULL → SYSTEM_OWNER_UUID.
 * Non-uuid legacy values throw 400 (write paths) — read paths catch this
 * and surface `corrupted: resolve-failed` instead (see enrich()).
 */
export function ownerKeyOrThrow(ownerId: string | null): string {
  if (ownerId === null || ownerId === undefined) return SYSTEM_OWNER_UUID;
  const raw = String(ownerId).trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
  ) {
    throw new BadRequestException("ownerId must be a uuid");
  }
  return raw;
}

export type Project = {
  id: string;
  name: string;
  description: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  githubBranch: string | null;
  githubUrl: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Computed (no DB column, no migration): true when the DB row exists but
   * the on-disk repo is missing or fails git validation. Read endpoints
   * never 404/500 for this — they surface the flag instead.
   */
  corrupted: boolean;
  /**
   * Machine reason when corrupted (missing-dir, no-git, rev-parse-failed,
   * storage-unconfigured, …). `storage-unconfigured` = REPOS_ROOT empty —
   * the row outlives usable storage config (additive, no migration).
   */
  corruptedReason?: string | null;
};

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    githubOwner: row.githubOwner,
    githubRepo: row.githubRepo,
    githubBranch: row.githubBranch,
    githubUrl: row.githubUrl,
    ownerId: row.ownerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    corrupted: false,
    corruptedReason: null,
  };
}

/**
 * Disk-first layout spec (frozen for create/list/getOrThrow/remove):
 *
 *   users/<ownerUuid>/projects/<project.id>/{content,.secrets}
 *     + users/<ownerUuid>/.secrets
 *   (org-scoped homes orgs/<orgUuid>/projects/<id>/… resolve via
 *   resolveOrg — see OrganizationsService; user homes always win for
 *   owner-bound rows here.)
 *   ownerKey = ownerKeyOrThrow(ownerId ?? SYSTEM_OWNER_UUID-nCoalesce):
 *     NULL owners deterministically map to SYSTEM_OWNER_UUID
 *     (users/00000000-…/…), never to a random space; non-uuid legacy
 *     ownerIds surface as `corrupted: resolve-failed` on reads (moved by
 *     hand per docs/manual-migration-orgs-layout.md).
 *   contentDir = project.id (uuid-validated, 400 on garbage).
 *
 * Storage-root canon: REPOS_ROOT is the SINGLE source of truth for project
 * storage — reads AND writes. create()/remove() go through
 * WorkspacePathService.requireExplicitRoot()/resolveUserStrict() — empty
 * REPOS_ROOT throws 500 before any mkdir/INSERT (no silent <cwd>/repos
 * fallback for writes; no row is written unconfigured). Storage READS outside
 * the projects registry (repos list, workspaces tree/submodules,
 * project-files tree, clone dest) deny with 503 EXTERNAL_UNAVAILABLE when
 * REPOS_ROOT is empty (never a silent []/404 over <cwd>/repos). Only the
 * projects registry reads (list/getOrThrow) surface the computed `corrupted`
 * flag with reason `storage-unconfigured` instead of denying.
 * Explicit-but-missing REPOS_ROOT is OK: create() runs `mkdir -p`
 * recursive (disk-first init: content + empty `.secrets` reserves).
 *
 * ownerId policy: IMMUTABLE after create (update() rejects any change with
 * 400). Rationale: the user home derives from ownerId, so a change would
 * orphan the on-disk repo (old dir stranded, new dir missing → corrupted).
 * A move variant (rename inside jail + git re-verify) was considered and
 * REJECTED for now — no silent data moves; a future explicit move endpoint
 * can add it with jail + git checks.
 *
 * The uuid id is stable across renames (name is display-only).
 *
 * create() does not know the id before INSERT (uuid defaultRandom), so the
 * id must be pre-generated in the service. Two options were considered:
 *   A. randomUUID() in the service before mkdir, then INSERT with the
 *      explicit id — disk-first holds (no row exists until the repo is
 *      initialized). CHOSEN.
 *   B. Two-phase INSERT → mkdir → UPDATE — violates disk-first (a row is
 *      visible before the repo exists; a disk failure leaves a corrupted
 *      row behind). REJECTED.
 */

/**
 * ProjectsService — Postgres-backed registry (strict, no memory fallback)
 * with disk-first repo initialization.
 *
 * Every method hits the `projects` table (drizzle/0001_projects.sql); data
 * survives restarts. When Postgres is unconfigured/unreachable the drizzle
 * throw funnels through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30 via ApiErrorFilter), logged once with the correlationId.
 *
 * Disk-first: create() mints the uuid, requires the explicit REPOS_ROOT
 * canon (empty → 500 before any mkdir/INSERT, no <cwd>/repos fallback for
 * writes), initializes users/<ownerUuid>/projects/<id>/content as a
 * non-bare git repo (`git init -b main` + empty `init` commit, execFile
 * argv only, no shell, plus empty `.secrets` reserves) and only then
 * INSERTs the row. Reads surface the computed
 * `corrupted` flag when the row outlives its directory (`storage-unconfigured`
 * when REPOS_ROOT is empty); remove() DELETEs the row first and cleans the
 * directory best-effort inside the strict jail.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("ProjectsService"),
    private readonly db: DbService,
    private readonly paths: WorkspacePathService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /**
   * Enrich a DB-backed project with the computed `corrupted` flag.
   * Never throws: any unexpected failure marks the project corrupted
   * (reason `check-failed`) instead of 500ing the read. Logs carry only
   * projectId/path/reason — never secrets.
   *
   * Unconfigured storage (empty REPOS_ROOT) → corrupted with reason
   * `storage-unconfigured` (reads never 404/500 for this).
   * ownerKey fallback: `ownerId ?? SYSTEM_OWNER_UUID` — NULL owners
   * deterministically map to the nil-uuid user home (see layout spec);
   * non-uuid legacy owners → `resolve-failed` (hand-migrated per the
   * manual-migration doc).
   */
  private async enrich(project: Project, correlationId?: string): Promise<Project> {
    try {
      if (!this.paths.isExplicitRootConfigured()) {
        this.logger.warn({
          projectId: project.id,
          path: "",
          reason: "storage-unconfigured",
        }, correlationId);
        return { ...project, corrupted: true, corruptedReason: "storage-unconfigured" };
      }
      let absRepo: string;
      try {
        const ownerKey = ownerKeyOrThrow(project.ownerId);
        absRepo = (await this.paths.resolveUser(ownerKey, project.id)).absRepo;
      } catch {
        this.logger.warn({
          projectId: project.id,
          path: "",
          reason: "resolve-failed",
        }, correlationId);
        return { ...project, corrupted: true, corruptedReason: "resolve-failed" };
      }
      try {
        const st = await stat(absRepo);
        if (!st.isDirectory()) throw new Error("not-a-directory");
      } catch {
        this.logger.warn({
          projectId: project.id,
          path: absRepo,
          reason: "missing-dir",
        }, correlationId);
        return { ...project, corrupted: true, corruptedReason: "missing-dir" };
      }
      const check = await isValidGitRepo(absRepo);
      if (!check.ok) {
        const reason = check.reason ?? "invalid-git";
        this.logger.warn({ projectId: project.id, path: absRepo, reason }, correlationId);
        return { ...project, corrupted: true, corruptedReason: reason };
      }
      return project;
    } catch {
      this.logger.warn({
        projectId: project.id,
        path: "",
        reason: "check-failed",
      }, correlationId);
      return { ...project, corrupted: true, corruptedReason: "check-failed" };
    }
  }

  /**
   * Best-effort removal of a project repo dir. Strict root only
   * (requireExplicitRoot + jail assertion); unconfigured storage → warn
   * `storage-unconfigured` and skip (never touch <cwd>/repos). Failures warn
   * (projectId/path/reason) and never mask the caller's outcome.
   */
  private async removeRepoDirBestEffort(
    projectId: string,
    ownerId: string | null,
    correlationId?: string,
  ): Promise<void> {
    try {
      // Legacy non-uuid owners have no user home in the new layout — warn
      // `resolve-failed` and skip (never touch an unscoped path).
      const ownerKey = ownerKeyOrThrow(ownerId);
      const resolved = await this.paths.resolveUserStrict(ownerKey, projectId);
      const jailReal = await this.paths.realStrictRoot();
      await this.paths.assertInsideJail(resolved.absBase, jailReal);
      await rm(resolved.absBase, { recursive: true, force: true });
    } catch (err) {
      const reason =
        err instanceof InternalServerErrorException
          ? "storage-unconfigured"
          : `rm-failed: ${(err as Error).message}`.slice(0, 120);
      this.logger.warn({ projectId, path: "", reason }, correlationId);
    }
  }

  async list(correlationId?: string): Promise<Project[]> {
    try {
      const rows = await this.client().select().from(projects);
      const enriched = await Promise.all(rows.map((r) => this.enrich(toProject(r), correlationId)));
      return enriched.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (err) {
      dbUnavailable("projects.list", err, this.logger, correlationId);
    }
  }

  /**
   * Disk-first create: strict-root check → resolve jailed user home →
   * `mkdir -p` (content + empty `.secrets` reserves) → `git init` + empty
   * `init` commit inside `content` (execFile, argv arrays, no shell) →
   * only then INSERT with the pre-generated id.
   *
   * Non-uuid ownerId → 400 before any disk/DB touch. Unconfigured storage
   * (empty REPOS_ROOT) → 500 (correlationId-bound, no secrets) with NO
   * mkdir and NO row written. Disk failure → 500 likewise. DB failure after
   * a successful disk init → best-effort rm of the fresh home inside the
   * jail, then the original DB error propagates unmasked via dbUnavailable
   * (503). Returns the enrich-verified project (never raw toProject) so a
   * just-created row always carries a fresh corrupted check.
   */
  async create(
    input: CreateProjectInput,
    correlationId?: string,
  ): Promise<Project> {
    const githubUrl =
      input.githubUrl ??
      (input.githubOwner && input.githubRepo
        ? `https://github.com/${input.githubOwner}/${input.githubRepo}`
        : null);
    // Variant A: id is minted before any disk write so the repo dir is
    // derived deterministically (see layout spec above).
    const id = randomUUID();
    // 400 on non-uuid ownerId before the strict-root gate touches disk.
    const ownerKey = ownerKeyOrThrow(input.ownerId ?? null);
    // Strict root first: empty REPOS_ROOT → 500 before any mkdir/INSERT.
    // 400/403 on bad shape/traversal — propagate before touching disk or DB.
    let absRepo: string;
    let absBase: string;
    try {
      const resolved = await this.paths.resolveUserStrict(ownerKey, id);
      absRepo = resolved.absRepo;
      absBase = resolved.absBase;
      // Belt-and-braces jail assertion before the first write.
      await this.paths.assertInsideJail(absBase, await this.paths.realStrictRoot());
      await this.paths.ensureProjectDirs(resolved);
    } catch (err) {
      if (err instanceof InternalServerErrorException) {
        this.logger.error(
          `[projects] storage unconfigured id=${id}`,
          undefined,
          correlationId,
        );
        throw err;
      }
      throw err;
    }
    try {
      await mkdir(absRepo, { recursive: true });
      const opts = { cwd: absRepo, timeout: PROJECT_GIT_TIMEOUT_MS };
      await execFileAsync("git", ["init", "-b", "main"], opts);
      // Local identity so the empty commit never fails on machines without
      // a global git identity (repo-scoped, does not touch global config).
      await execFileAsync("git", ["config", "user.email", "devbox@localhost"], opts);
      await execFileAsync("git", ["config", "user.name", "devbox"], opts);
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], opts);
    } catch (err) {
      this.logger.error(
        `[projects] disk init failed id=${id}: ${(err as Error).message}`,
        (err as Error).stack,
        correlationId,
      );
      throw new InternalServerErrorException(
        "Failed to initialize project storage",
      );
    }
    try {
      const rows = await this.client()
        .insert(projects)
        .values({
          id,
          name: input.name,
          description: input.description ?? null,
          githubOwner: input.githubOwner ?? null,
          githubRepo: input.githubRepo ?? null,
          githubBranch: input.githubBranch ?? "main",
          githubUrl,
          ownerId: input.ownerId ?? null,
        })
        .returning();
      const project = await this.enrich(toProject(rows[0]), correlationId);
      // Lifecycle events (low frequency) stay at info; cid-bound.
      this.logger.info(`[projects] created ${project.id}`, correlationId);
      return project;
    } catch (err) {
      await this.removeRepoDirBestEffort(id, input.ownerId ?? null, correlationId);
      dbUnavailable("projects.create", err, this.logger, correlationId);
    }
  }

  async getOrThrow(id: string, correlationId?: string): Promise<Project> {
    try {
      const rows = await this.client()
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      if (rows.length === 0)
        throw new NotFoundException(`Project ${id} not found`);
      return await this.enrich(toProject(rows[0]), correlationId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("projects.getOrThrow", err, this.logger, correlationId);
    }
  }

  async update(
    id: string,
    input: UpdateProjectInput,
    correlationId?: string,
  ): Promise<Project> {
    const current = await this.getOrThrow(id, correlationId);
    // ownerId is IMMUTABLE: userSpace derives from it, so a change would
    // orphan the on-disk repo (stranded old dir, missing new dir). Reject
    // with 400; a future explicit move endpoint can add jailed rename + git
    // re-verify. No silent directory moves here.
    if (
      input.ownerId !== undefined &&
      (input.ownerId ?? null) !== current.ownerId
    ) {
      throw new BadRequestException(
        "ownerId is immutable after create (would orphan the project directory)",
      );
    }
    const next: Project = {
      ...current,
      name: input.name ?? current.name,
      description:
        input.description !== undefined
          ? (input.description ?? null)
          : current.description,
      githubOwner:
        input.githubOwner !== undefined
          ? (input.githubOwner ?? null)
          : current.githubOwner,
      githubRepo:
        input.githubRepo !== undefined
          ? (input.githubRepo ?? null)
          : current.githubRepo,
      githubBranch:
        input.githubBranch !== undefined
          ? (input.githubBranch ?? "main")
          : current.githubBranch,
      ownerId:
        input.ownerId !== undefined ? (input.ownerId ?? null) : current.ownerId,
      updatedAt: new Date().toISOString(),
    };
    if (input.githubUrl !== undefined) {
      next.githubUrl = input.githubUrl ?? null;
    } else if (
      input.githubOwner !== undefined ||
      input.githubRepo !== undefined
    ) {
      next.githubUrl =
        next.githubOwner && next.githubRepo
          ? `https://github.com/${next.githubOwner}/${next.githubRepo}`
          : null;
    }
    try {
      const rows = await this.client()
        .update(projects)
        .set({
          name: next.name,
          description: next.description,
          githubOwner: next.githubOwner,
          githubRepo: next.githubRepo,
          githubBranch: next.githubBranch,
          githubUrl: next.githubUrl,
          ownerId: next.ownerId,
          updatedAt: new Date(next.updatedAt),
        })
        .where(eq(projects.id, id))
        .returning();
      if (rows.length === 0)
        throw new NotFoundException(`Project ${id} not found`);
      this.logger.info(`[projects] updated ${id}`, correlationId);
      return await this.enrich(toProject(rows[0]), correlationId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("projects.update", err, this.logger, correlationId);
    }
  }

  async remove(id: string, correlationId?: string): Promise<void> {
    const current = await this.getOrThrow(id, correlationId);
    try {
      // FK cascade removes project_chats / project_sessions rows.
      await this.client().delete(projects).where(eq(projects.id, id));
      this.logger.info(`[projects] removed ${id}`, correlationId);
    } catch (err) {
      dbUnavailable("projects.remove", err, this.logger, correlationId);
    }
    // Disk cleanup is best-effort AFTER the row is gone: an rm failure
    // warns (projectId/path/reason) and never masks the DELETE.
    await this.removeRepoDirBestEffort(id, current.ownerId, correlationId);
  }

  async linkGithub(
    id: string,
    input: GithubLinkInput,
    correlationId?: string,
  ): Promise<Project> {
    const current = await this.getOrThrow(id, correlationId);
    const branch = input.branch ?? "main";
    const next: Project = {
      ...current,
      githubOwner: input.owner,
      githubRepo: input.repo,
      githubBranch: branch,
      githubUrl: `https://github.com/${input.owner}/${input.repo}`,
      updatedAt: new Date().toISOString(),
    };
    try {
      const rows = await this.client()
        .update(projects)
        .set({
          githubOwner: next.githubOwner,
          githubRepo: next.githubRepo,
          githubBranch: next.githubBranch,
          githubUrl: next.githubUrl,
          updatedAt: new Date(next.updatedAt),
        })
        .where(eq(projects.id, id))
        .returning();
      if (rows.length === 0)
        throw new NotFoundException(`Project ${id} not found`);
      this.logger.info(`[projects] github linked ${id}`, correlationId);
      return await this.enrich(toProject(rows[0]), correlationId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("projects.linkGithub", err, this.logger, correlationId);
    }
  }

  async unlinkGithub(id: string, correlationId?: string): Promise<Project> {
    const current = await this.getOrThrow(id, correlationId);
    const next: Project = {
      ...current,
      githubOwner: null,
      githubRepo: null,
      githubBranch: null,
      githubUrl: null,
      updatedAt: new Date().toISOString(),
    };
    try {
      const rows = await this.client()
        .update(projects)
        .set({
          githubOwner: null,
          githubRepo: null,
          githubBranch: null,
          githubUrl: null,
          updatedAt: new Date(next.updatedAt),
        })
        .where(eq(projects.id, id))
        .returning();
      if (rows.length === 0)
        throw new NotFoundException(`Project ${id} not found`);
      this.logger.info(`[projects] github unlinked ${id}`, correlationId);
      return await this.enrich(toProject(rows[0]), correlationId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("projects.unlinkGithub", err, this.logger, correlationId);
    }
  }

  /** Test/e2e seam — DELETE FROM projects (cascades chats/sessions; requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    await this.client().delete(projects);
  }
}
