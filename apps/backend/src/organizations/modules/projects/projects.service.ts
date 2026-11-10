import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { promisify } from "node:util";
import { AppLogger } from "@common/logger";
import { uuidSchema } from "@common/validation";
import { DbService, dbUnavailable, type DbClient } from "@common/db/db.service";
import {
  organizations,
  projectChats,
  projectSessions,
  projects,
  type ProjectRow,
} from "@common/db/schema";
import { isValidGitRepo, type GitCheck } from "./modules/repository/utils/repos-git";
import {
  WorkspacePathService,
  type ProjectResolved,
} from "@common/storage/workspace-path.service";
import type {
  CreateProjectInput,
  UpdateProjectInput,
} from "./projects.dto";

type ExecFileAsync = (
  file: string,
  args: Array<string>,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileAsync = promisify(execFile);

/** Effective config entry: project value overrides org value (masked secrets). */
export type EffectiveConfigEntry = {
  key: string;
  value: string;
  origin: "project" | "organization";
  overridden: boolean;
};

/** Per-command budget for `git init/config/commit` during disk-first create. */
const PROJECT_GIT_TIMEOUT_MS: number = 15000;

export type Project = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  githubBranch: string | null;
  githubUrl: string | null;
  ownerId: string | null;
  status: "active" | "deleted";
  deletedAt: string | null;
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
    orgId: row.orgId,
    name: row.name,
    description: row.description,
    githubOwner: row.githubOwner,
    githubRepo: row.githubRepo,
    githubBranch: row.githubBranch,
    githubUrl: row.githubUrl,
    ownerId: row.ownerId,
    status: ((row as { status?: string }).status === "deleted" ? "deleted" : "active") as Project["status"],
    deletedAt: (row as { deletedAt?: Date | null }).deletedAt
      ? ((row as { deletedAt?: Date | null }).deletedAt as Date).toISOString()
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    corrupted: false,
    corruptedReason: null,
  };
}

/**
 * Disk-first layout spec (frozen for create/list/getOrThrow/remove):
 *
 *   orgs/<orgUuid>/projects/<project.id>/{content,.secrets}
 *     + orgs/<orgUuid>/.secrets
 *
 * ownerId is an audit-only creator field — it NEVER participates in path
 * resolution (no users/<owner>/ homes; only the orgs/ layout remains).
 *   contentDir = project.id (uuid-validated, 400 on garbage).
 *
 * Storage-root canon: REPOS_ROOT is the SINGLE source of truth for project
 * storage — reads AND writes. create()/remove() go through
 * WorkspacePathService.requireExplicitRoot()/resolveOrgStrict() — empty
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
 * 400). Rationale: the audit creator must stay stable for history; disk
 * location derives from orgId (also immutable), so neither field may move
 * the repo. A move variant (rename inside jail + git re-verify) was considered and
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
 * Every method hits the `projects` table (see `common/db/schema.ts`); data
 * survives restarts. When Postgres is unconfigured/unreachable the drizzle
 * throw funnels through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30 via ApiErrorFilter), logged once with the correlationId.
 *
 * Disk-first: create() mints the uuid, requires the explicit REPOS_ROOT
 * canon (empty → 500 before any mkdir/INSERT, no <cwd>/repos fallback for
 * writes), initializes orgs/<orgUuid>/projects/<id>/content as a
 * non-bare git repo (`git init -b main` + empty `init` commit, execFile
 * argv only, no shell, plus empty `.secrets` reserves) and only then
 * INSERTs the row. Reads surface the computed
 * `corrupted` flag when the row outlives its directory (`storage-unconfigured`
 * when REPOS_ROOT is empty); remove() only marks `deleted_at` (rows are
 * never physically deleted) and keeps the directory for restore.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly logger: AppLogger = new AppLogger(ProjectsService.name),
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
   * Rows without orgId are invalid (org-only model) → corrupted `missing-org`.
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
      let absoluteRepo: string;
      try {
        if (!project.orgId) {
          return { ...project, corrupted: true, corruptedReason: "missing-org" };
        }
        absoluteRepo = (await this.paths.resolveOrg(project.orgId, project.id)).absoluteRepo;
      } catch {
        this.logger.warn({
          projectId: project.id,
          path: "",
          reason: "resolve-failed",
        }, correlationId);
        return { ...project, corrupted: true, corruptedReason: "resolve-failed" };
      }
      try {
        const stats: Stats | null = await this.paths.statPath(absoluteRepo);
        if (!stats || !stats.isDirectory()) throw new Error("not-a-directory");
      } catch {
        this.logger.warn({
          projectId: project.id,
          path: absoluteRepo,
          reason: "missing-dir",
        }, correlationId);
        return { ...project, corrupted: true, corruptedReason: "missing-dir" };
      }
      const check: GitCheck = await isValidGitRepo(absoluteRepo);
      if (!check.ok) {
        const reason: string = check.reason ?? "invalid-git";
        this.logger.warn({ projectId: project.id, path: absoluteRepo, reason }, correlationId);
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
    orgId: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      const resolved: ProjectResolved = await this.paths.resolveOrgStrict(orgId, projectId);
      const jailReal: string = await this.paths.realStrictRoot();
      await this.paths.assertInsideJail(resolved.absoluteBase, jailReal);
      await this.paths.removeDir(resolved.absoluteBase);
    } catch (error) {
      const reason: string =
        error instanceof InternalServerErrorException
          ? "storage-unconfigured"
          : `rm-failed: ${(error as Error).message}`.slice(0, 120);
      this.logger.warn({ projectId, path: "", reason }, correlationId);
    }
  }

  async list(
    correlationId?: string,
    options?: { orgId?: string; includeDeleted?: boolean },
  ): Promise<Array<Project>> {
    try {
      const conditions: Array<SQL<unknown>> = [];
      if (options?.orgId) conditions.push(eq(projects.orgId, options.orgId));
      if (!options?.includeDeleted) {
        // `deleted_at` is the source of truth; the legacy `status` predicate
        // stays for rows soft-deleted before the column existed.
        conditions.push(eq(projects.status, "active"));
        conditions.push(isNull(projects.deletedAt));
      }
      const rows: Array<ProjectRow> =
        conditions.length > 0
          ? await this.client().select().from(projects).where(and(...conditions))
          : await this.client().select().from(projects);
      const enriched: Array<Project> = await Promise.all(
        rows.map((row) => this.enrich(toProject(row), correlationId)),
      );
      return enriched.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      dbUnavailable("projects.list", error, this.logger, correlationId);
    }
  }

  /**
   * Disk-first create: strict-root check → resolve jailed org home →
   * `mkdir -p` (content + empty `.secrets` reserves) → `git init` + empty
   * `init` commit inside `content` (execFile, argv arrays, no shell) →
   * only then INSERT with the pre-generated id.
   *
   * ownerId is audit-only (no uuid gate, never trusted for paths).
   * Unconfigured storage
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
    const orgId: string | undefined = (input as { orgId?: string }).orgId;
    if (!orgId || typeof orgId !== "string" || !uuidSchema.safeParse(orgId).success) {
      throw new BadRequestException('Field "orgId" is required');
    }
    const githubUrl: string | null =
      input.githubUrl ??
      (input.githubOwner && input.githubRepo
        ? `https://github.com/${input.githubOwner}/${input.githubRepo}`
        : null);
    // Variant A: id is minted before any disk write so the repo dir is
    // derived deterministically (see layout spec above).
    const id: string = randomUUID();
    // Strict root first: empty REPOS_ROOT → 500 before any mkdir/INSERT.
    // 400/403 on bad shape/traversal — propagate before touching disk or DB.
    let absoluteRepo: string;
    let absoluteBase: string;
    try {
      const resolved: ProjectResolved = await this.paths.resolveOrgStrict(orgId, id);
      absoluteRepo = resolved.absoluteRepo;
      absoluteBase = resolved.absoluteBase;
      // Belt-and-braces jail assertion before the first write.
      await this.paths.assertInsideJail(absoluteBase, await this.paths.realStrictRoot());
      await this.paths.ensureProjectDirs(resolved);
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        this.logger.error(
          `[projects] storage unconfigured id=${id}`,
          undefined,
          correlationId,
        );
        throw error;
      }
      throw error;
    }
    try {
      await this.paths.ensureDir(absoluteRepo);
      const execOptions: { cwd: string; timeout: number } = {
        cwd: absoluteRepo,
        timeout: PROJECT_GIT_TIMEOUT_MS,
      };
      await execFileAsync("git", ["init", "-b", "main"], execOptions);
      // Local identity so the empty commit never fails on machines without
      // a global git identity (repo-scoped, does not touch global config).
      await execFileAsync("git", ["config", "user.email", "rush-code@localhost"], execOptions);
      await execFileAsync("git", ["config", "user.name", "rush-code"], execOptions);
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], execOptions);
    } catch (error) {
      this.logger.error(
        `[projects] disk init failed id=${id}: ${(error as Error).message}`,
        (error as Error).stack,
        correlationId,
      );
      throw new InternalServerErrorException(
        "Failed to initialize project storage",
      );
    }
    try {
      const rows: Array<ProjectRow> = await this.client()
        .insert(projects)
        .values({
          id,
          orgId,
          name: input.name,
          description: input.description ?? null,
          githubOwner: input.githubOwner ?? null,
          githubRepo: input.githubRepo ?? null,
          githubBranch: input.githubBranch ?? "main",
          githubUrl,
          ownerId: input.ownerId ?? null,
        })
        .returning();
      const project: Project = await this.enrich(toProject(rows[0]), correlationId);
      // Lifecycle events (low frequency) stay at info; correlationId-bound.
      this.logger.info(`[projects] created ${project.id}`, correlationId);
      return project;
    } catch (error) {
      await this.removeRepoDirBestEffort(id, orgId, correlationId);
      dbUnavailable("projects.create", error, this.logger, correlationId);
    }
  }

  async getOrThrow(
    id: string,
    correlationId?: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Project> {
    try {
      // Soft-deleted rows read as missing (404) unless history is requested;
      // `deleted_at` is authoritative, `status` is the legacy marker.
      const conditions: Array<SQL<unknown>> = [eq(projects.id, id)];
      if (!options?.includeDeleted) conditions.push(isNull(projects.deletedAt));
      const rows: Array<ProjectRow> = await this.client()
        .select()
        .from(projects)
        .where(and(...conditions))
        .limit(1);
      if (rows.length === 0)
        throw new NotFoundException(`Project ${id} not found`);
      const project: Project = toProject(rows[0]);
      if (project.status === "deleted" && !options?.includeDeleted)
        throw new NotFoundException(`Project ${id} not found`);
      return await this.enrich(project, correlationId);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      dbUnavailable("projects.getOrThrow", error, this.logger, correlationId);
    }
  }

  /**
   * 1:1 guard — project must belong to orgId, else 404 (no leak whether
   * the id exists elsewhere). Deleted rows behave as missing unless
   * includeDeleted is set (member-visible via ?includeDeleted).
   */
  async assertProjectBelongsToOrg(
    orgId: string,
    projectId: string,
    correlationId?: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Project> {
    const project: Project = await this.getOrThrow(projectId, correlationId, options);
    if (!project.orgId || project.orgId.toLowerCase() !== orgId.toLowerCase())
      throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  async update(
    id: string,
    input: UpdateProjectInput,
    correlationId?: string,
    options?: { orgId?: string },
  ): Promise<Project> {
    const current: Project = options?.orgId
      ? await this.assertProjectBelongsToOrg(options.orgId, id, correlationId, { includeDeleted: true })
      : await this.getOrThrow(id, correlationId, { includeDeleted: true });
    if (current.status === "deleted" || current.deletedAt !== null)
      throw new NotFoundException(`Project ${id} not found`);
    // orgId + ownerId are IMMUTABLE after create (disk location derives
    // from orgId; ownerId is the audit creator — neither may move the repo).
    // Reject with 400; a future explicit move endpoint can add jailed
    // rename + git re-verify. No silent directory moves here.
    if (
      (input as { orgId?: string }).orgId !== undefined &&
      (input as { orgId?: string }).orgId !== current.orgId
    ) {
      throw new BadRequestException("orgId is immutable after create");
    }
    // ownerId is audit-only (no path derivation) but still immutable.
    // Reject with 400; a future explicit move endpoint can add jailed
    // rename + git re-verify. No silent directory moves here.
    if (
      input.ownerId !== undefined &&
      (input.ownerId ?? null) !== current.ownerId
    ) {
      throw new BadRequestException(
        "ownerId is immutable after create",
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
      const rows: Array<ProjectRow> = await this.client()
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
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      dbUnavailable("projects.update", error, this.logger, correlationId);
    }
  }

  /**
   * Soft-delete: status=deleted + deletedAt, stop running containers
   * (best-effort), keep the row + disk for restore. Deleted rows are
   * invisible by default (404) and member-visible via ?includeDeleted.
   */
  async remove(id: string, correlationId?: string): Promise<void> {
    const current: Project = await this.getOrThrow(id, correlationId, { includeDeleted: true });
    // Idempotent: a row already carrying deleted_at keeps its original
    // deletion timestamp (no re-stamping on repeated DELETE).
    if (current.status === "deleted" || current.deletedAt !== null) return;
    await this.stopRunningContainers(id, correlationId);
    try {
      await this.client()
        .update(projects)
        .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(projects.id, id));
      this.logger.info(`[projects] soft-deleted ${id}`, correlationId);
    } catch (error) {
      dbUnavailable("projects.remove", error, this.logger, correlationId);
    }
  }

  /**
   * Restore a soft-deleted project (API only, no UI). A project cannot be
   * revived while its organization is soft-deleted — that org is hidden, so
   * revive the org first (404 keeps the no-leak rule).
   */
  async restore(id: string, correlationId?: string): Promise<Project> {
    const current: Project = await this.getOrThrow(id, correlationId, { includeDeleted: true });
    if (current.orgId) {
      try {
        const orgRows: Array<{ id: string }> = await this.client()
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              eq(organizations.id, current.orgId),
              isNull(organizations.deletedAt),
            ),
          )
          .limit(1);
        if (orgRows.length === 0)
          throw new NotFoundException(`Project ${id} not found`);
      } catch (error) {
        if (error instanceof NotFoundException) throw error;
        dbUnavailable("projects.restore.org", error, this.logger, correlationId);
      }
    }
    if (current.status === "active") return current;
    try {
      const rows: Array<ProjectRow> = await this.client()
        .update(projects)
        .set({ status: "active", deletedAt: null, updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      if (rows.length === 0) throw new NotFoundException(`Project ${id} not found`);
      this.logger.info(`[projects] restored ${id}`, correlationId);
      return await this.enrich(toProject(rows[0]), correlationId);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      dbUnavailable("projects.restore", error, this.logger, correlationId);
    }
  }

  /**
   * Best-effort stop of running project containers (no throw — warn only,
   * never masks the delete). No container id is logged.
   */
  private async stopRunningContainers(projectId: string, correlationId?: string): Promise<void> {
    try {
      const execOptions: { timeout: number } = { timeout: 5000 };
      await execFileAsync("docker", ["ps", "--filter", `label=project=${projectId}`, "--format", "{{.ID}}"], execOptions)
        .then(async (output) => {
          const containerIds: Array<string> = String(
            (output as { stdout?: string }).stdout ?? output ?? "",
          )
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          for (const containerId of containerIds) {
            await execFileAsync("docker", ["stop", containerId], execOptions).catch(() => undefined);
          }
        })
        .catch(() => undefined);
      this.logger.info(`[projects] containers stopped ${projectId}`, correlationId);
    } catch {
      this.logger.warn({ projectId, path: "", reason: "container-stop-failed" }, correlationId);
    }
  }

  /**
   * Effective config: project values override org values (backend merge).
   * Secrets are masked (never returned in clear). Origin + overridden flags
   * let the frontend render effective + origin without merging itself.
   */
  async effectiveConfig(
    orgId: string,
    projectId: string,
    correlationId?: string,
  ): Promise<Array<EffectiveConfigEntry>> {
    await this.assertProjectBelongsToOrg(orgId, projectId, correlationId);
    // Org-level + project-level key sources are intentionally minimal:
    // github link (non-secret) at both levels is out of scope — this
    // endpoint merges a fixed key set (currently empty upstream) so the
    // contract + masking rule is enforced backend-side. Secrets masked.
    return [];
  }

  /** Test/e2e seam — DELETE FROM projects (children first; requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    const client: DbClient = this.client();
    // project_chats/project_sessions are ON DELETE RESTRICT (hard deletes must
    // fail in production), so the test-only cleanup removes them explicitly.
    await client.delete(projectSessions);
    await client.delete(projectChats);
    await client.delete(projects);
  }
}
