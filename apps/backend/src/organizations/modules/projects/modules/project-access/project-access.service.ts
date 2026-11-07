import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AppLogger } from "../../../../../common/logger";
import {
  DbService,
  dbUnavailable,
  type DbClient,
} from "../../../../../common/db/db.service";
import { WorkspacePathService } from "../../../../../common/storage/workspace-path.service";
import { OrganizationsGuard } from "../../../../organizations.guard";
import type { OrgRole } from "../../../../organizations.types";

/** uuid shape check (mirrors UsersService.isUserId — non-uuid keys never match a row). */
function isUuidKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * ProjectAccessService — the C4 project-access gate, owned by the projects
 * domain (nested module under `organizations/modules/projects/modules/`
 * per CoC §2). Moved verbatim out of the organizations service so that
 * ProjectsModule and its nested modules (chats/sessions/files) no longer
 * import the organizations module (the up-arrow is gone; the dependency now
 * points projects → project-access only).
 *
 * Reads the 1:1 `projects` table directly (dynamic imports, no
 * ProjectsService injection, no module cycle) and delegates membership to
 * OrganizationsGuard.getRole (the guard is stateless, provided directly by
 * ProjectAccessModule — same pattern as WorkspacePathService).
 *
 * Postgres outages funnel through `dbUnavailable` → 503
 * EXTERNAL_UNAVAILABLE (Retry-After 30 via ApiErrorFilter), logged once with
 * the correlationId. Logs carry only ids/reasons — never tokens, emails, or
 * secrets.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly logger: AppLogger = new AppLogger(ProjectAccessService.name),
    private readonly db: DbService,
    private readonly guard: OrganizationsGuard,
    private readonly paths: WorkspacePathService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Org ids a project is attached to (access-layer helper, no auth). */
  async orgIdsForProject(
    projectId: string,
    correlationId?: string,
  ): Promise<Array<string>> {
    try {
      const { projects } = await import("../../../../../common/db/schema");
      const { eq: eqOp } = await import("drizzle-orm");
      const rows = await this.client()
        .select({ orgId: projects.orgId })
        .from(projects)
        .where(eqOp(projects.id, projectId));
      const orgId = rows[0]?.orgId;
      return orgId ? [orgId] : [];
    } catch (err) {
      dbUnavailable(
        "organizations.orgIdsForProject",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  /** Null for strangers (access-layer helper — callers map null → 404). */
  async getRole(
    orgId: string,
    userId: string,
    correlationId?: string,
  ): Promise<OrgRole | null> {
    return this.guard.getRole(orgId, userId, correlationId);
  }

  /**
   * Project row loader for project-scoped callers that only have the
   * project id (no org path, no owner): selects { orgId, ownerId } from
   * the 1:1 `projects` table (same dynamic-import pattern as
   * orgIdsForProject — no ProjectsService dependency, no module cycle).
   * Missing (or soft-deleted) rows → 404; DB outages → 503 via dbUnavailable
   * (never 404).
   */
  async projectAccessRow(
    projectId: string,
    correlationId?: string,
  ): Promise<{ orgId: string | null; ownerId: string | null }> {
    try {
      const { projects } = await import("../../../../../common/db/schema");
      const { and: andOp, eq: eqOp, isNull: isNullOp } = await import("drizzle-orm");
      const rows = await this.client()
        .select({ orgId: projects.orgId, ownerId: projects.ownerId })
        .from(projects)
        .where(
          andOp(eqOp(projects.id, projectId), isNullOp(projects.deletedAt)),
        );
      if (rows.length === 0)
        throw new NotFoundException(`Project ${projectId} not found`);
      return {
        orgId: rows[0].orgId ?? null,
        ownerId: (rows[0].ownerId as string | null) ?? null,
      };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable(
        "organizations.projectAccessRow",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  /**
   * Project-id gate for project-scoped surfaces without an org path
   * (opencode serve/session proxy, C4): loads the row, then runs the
   * shared assertProjectAccess (org membership only; strangers → 404, no
   * existence leak). Missing projectId at the call site is the caller's
   * 400 (PROJECT_REQUIRED) — this method only gates a present id.
   * Returns the row's owner/orgs so callers can resolve the project
   * directory jail without a second lookup.
   */
  async assertProjectAccessById(
    projectId: string,
    userId: string,
    correlationId?: string,
  ): Promise<{ ownerId: string | null; orgIds: Array<string> }> {
    const row = await this.projectAccessRow(projectId, correlationId);
    await this.assertProjectAccess(
      projectId,
      row.ownerId,
      userId,
      correlationId,
    );
    return { ownerId: row.ownerId, orgIds: row.orgId ? [row.orgId] : [] };
  }

  /**
   * Gate + directory jail for project-scoped session surfaces (C4).
   *
   * - Missing/blank projectId → 400 PROJECT_REQUIRED (session routes are
   *   project-scoped; there is no cross-project listing).
   * - assertProjectAccessById → 404 for strangers (no existence leak).
   * - The org home resolves via resolveOrgStrict, then the content dir is
   *   re-asserted against the strict storage root — a path that escapes
   *   the jail answers 403.
   * - Unconfigured storage fails closed (500) before any upstream call.
   * - Rows without orgId are invalid (org-only model) → 404.
   *
   * Returns the accepted projectId alongside the jailed content directory so
   * callers pass it as the upstream location instead of a client-supplied
   * path.
   */
  async resolveProjectDirectory(
    projectId: string | undefined,
    userId: string,
    correlationId?: string,
  ): Promise<{ projectId: string; directory: string }> {
    if (!projectId || projectId.trim() === "") {
      throw new BadRequestException({
        code: "PROJECT_REQUIRED",
        message: "projectId is required — session routes are project-scoped",
      });
    }
    const { orgIds } = await this.assertProjectAccessById(
      projectId,
      userId,
      correlationId,
    );
    const orgId = orgIds[0];
    if (!orgId) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    const resolved = await this.paths.resolveOrgStrict(
      orgId,
      projectId,
    );
    await this.paths.assertInsideJail(
      resolved.absRepo,
      await this.paths.realStrictRoot(),
    );
    return { projectId, directory: resolved.absRepo };
  }

  /**
   * Project access gate (Card 5 + C5) — shared by sessions/chats/project-files,
   * the top-level projects :id routes (C1) and the opencode/proxy project
   * gate via assertProjectAccessById (C4).
   *
   * Org-only model: the ONLY association is the `projects.org_id` column (NOT NULL)
   * selected directly from the projects row. The old link table is gone
   * (link/unlink answer 410 Gone); a project always belongs to exactly one
   * org. There is no user-space and no ownerless fallback.
   *
   * - Access to any member of the project org (`getRole` non-null).
   *   A soft-deleted org admits nobody.
   * - Rows without org_id are invalid: 404 for everyone (a project without
   *   an organization is not addressable). No owner-equality fallback:
   *   membership is the only rule.
   * - Strangers get 404 (the project's very existence is not leaked — the
   *   same no-enumeration rule as org reads). Non-uuid requesters (legacy
   *   mock `default`) skip the membership lookup (a non-uuid key can never
   *   match a uuid column) and get 404.
   * - DB outages propagate untouched as 503 EXTERNAL_UNAVAILABLE via
   *   orgIdsForProject/getRole's dbUnavailable (never downgraded to 404).
   * Logs carry only ids/reasons — never tokens, emails, or secrets.
   */
  async assertProjectAccess(
    projectId: string,
    _ownerId: string | null,
    userId: string,
    correlationId?: string,
  ): Promise<void> {
    void _ownerId;
    const orgIds = await this.orgIdsForProject(projectId, correlationId);
    if (orgIds.length === 0) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    for (const orgId of orgIds) {
      try {
        await this.guard.orgRowOrThrow(orgId, correlationId);
      } catch (err) {
        if (err instanceof NotFoundException)
          throw new NotFoundException(`Project ${projectId} not found`);
        throw err;
      }
      if (isUuidKey(userId)) {
        const role = await this.getRole(orgId, userId, correlationId);
        if (role) return;
      }
    }
    throw new NotFoundException(`Project ${projectId} not found`);
  }
}
