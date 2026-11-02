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
import { ownerKeyOrThrow } from "../../projects.service";

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
 * ProjectAccessModule — same pattern as WorkspacePathService). The only
 * import from the parent projects module is the pure ownerKeyOrThrow layout
 * mapping (no service instance, no cycle).
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
  ): Promise<string[]> {
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
   * shared assertProjectAccess (org-linked → member, user-space → owner;
   * strangers → 404, no existence leak). Missing projectId at the call
   * site is the caller's 400 (PROJECT_REQUIRED) — this method only gates
   * a present id. Returns the row's owner/orgs so callers can resolve the
   * project directory jail without a second lookup.
   */
  async assertProjectAccessById(
    projectId: string,
    userId: string,
    correlationId?: string,
  ): Promise<{ ownerId: string | null; orgIds: string[] }> {
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
   * - The owner home maps through ownerKeyOrThrow (same user layout the
   *   projects domain writes) and resolves via resolveUserStrict, then the
   *   content dir is re-asserted against the strict storage root — a path
   *   that escapes the jail answers 403.
   * - Unconfigured storage fails closed (500) before any upstream call.
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
    const { ownerId } = await this.assertProjectAccessById(
      projectId,
      userId,
      correlationId,
    );
    const resolved = await this.paths.resolveUserStrict(
      ownerKeyOrThrow(ownerId),
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
   * 1:1 model (M2M removed — docs live under this code): the ONLY
   * association is the `projects.org_id` column — orgIdsForProject selects
   * it directly from the projects row. The old `projects_and_organizations`
   * link table is gone (link/unlink answer 410 Gone, here and in the
   * controllers); a project belongs to exactly one org or to no org
   * (user-space). There is no multi-org membership walk anymore.
   *
   * - Org-linked project (org_id set): access to any member of that org
   *   (`getRole` non-null). The owner-equality fallback also passes — the
   *   creator is a maintainer in practice, so this never widens the member
   *   rule. A soft-deleted org (guard `orgRowOrThrow` → 404) admits nobody,
   *   including its owner.
   * - User-space project (org_id NULL, owner set): owner-only
   *   (ownerId === userId).
   * - Ownerless rows (ownerId NULL, pre-auth legacy): DENY by default → 404
   *   for everyone (C5). Rationale: an ownerless row binds to no identity,
   *   so the old "shared dev data" pass was an open door. New rows always
   *   carry a real owner (C1 forces ownerId = identity.id at both create
   *   paths); legacy rows need a hand migration (set ownerId) to become
   *   visible again.
   * - Strangers get 404 (the project's very existence is not leaked — the
   *   same no-enumeration rule as org reads). Non-uuid requesters (legacy
   *   mock `default`) skip the membership lookup (a non-uuid key can never
   *   match a uuid column — querying would 503 on 22P02) and only pass via
   *   the owner-equality fallback above.
   * - DB outages propagate untouched as 503 EXTERNAL_UNAVAILABLE via
   *   orgIdsForProject/getRole's dbUnavailable (never downgraded to 404).
   * Logs carry only ids/reasons — never tokens, emails, or secrets.
   */
  async assertProjectAccess(
    projectId: string,
    ownerId: string | null,
    userId: string,
    correlationId?: string,
  ): Promise<void> {
    const orgIds = await this.orgIdsForProject(projectId, correlationId);
    if (orgIds.length > 0) {
      for (const orgId of orgIds) {
        if (isUuidKey(userId)) {
          const role = await this.getRole(orgId, userId, correlationId);
          if (role) return;
        }
        // A soft-deleted org authorizes nobody — not even its owner (the
        // owner-equality fallback below must not resurrect a removed org).
        try {
          await this.guard.orgRowOrThrow(orgId, correlationId);
        } catch (err) {
          if (err instanceof NotFoundException)
            throw new NotFoundException(`Project ${projectId} not found`);
          throw err;
        }
      }
      if (
        typeof ownerId === "string" &&
        ownerId.toLowerCase() === userId.toLowerCase()
      ) {
        return;
      }
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    // C5 deny-by-default: ownerless rows (NULL owner, pre-auth legacy) admit
    // nobody — the old shared-dev-data pass is removed (open door). New rows
    // always carry a real owner (C1); legacy rows need a hand migration.
    if (ownerId === null || ownerId === undefined)
      throw new NotFoundException(`Project ${projectId} not found`);
    if (ownerId.toLowerCase() === userId.toLowerCase()) return;
    throw new NotFoundException(`Project ${projectId} not found`);
  }
}
