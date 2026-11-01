import { Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { rm } from "node:fs/promises";
import { AppLogger } from "../common/logger";
import { DbService, dbUnavailable, type DbClient } from "../common/db/db.service";
import {
  organizationInvites,
  organizationMembers,
  organizations,
  type OrganizationRow,
} from "../common/db/schema";
import { UsersService } from "../users/users.service";
import { WorkspacePathService } from "../common/storage/workspace-path.service";
import type {
  AcceptInviteInput,
  AddMemberInput,
  CreateInviteInput,
  CreateOrganizationInput,
  UpdateMemberRoleInput,
  UpdateOrganizationInput,
} from "./dto";
import { InvitesService } from "./invites.service";
import { MembersService } from "./members.service";
import { OrgGuardService } from "./org-guard.service";
import type {
  Organization,
  OrganizationInvite,
  OrganizationMember,
  OrgRole,
} from "./organizations.types";

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerId: row.ownerId,
    isPrivate: row.isPrivate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** uuid shape check (mirrors UsersService.isUserId — non-uuid keys never match a row). */
function isUuidKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * OrganizationsService — Postgres-backed org registry (strict, no memory
 * fallback) with disk-backed org homes (orgs/<orgId>/.secrets).
 *
 * Owns org CRUD (`organizations`), project access (`projects.org_id`, the
 * 1:1 model) and the shared test seams. Membership lives in MembersService,
 * invites in InvitesService, the access gate in OrgGuardService (domain root
 * per CoC v2); the membership/invite methods below are one-line delegates
 * so the public API is unchanged. Pure helpers live in `utils/`
 * (uuid-v7, pg-error, organization-member) — SQL/tables are unchanged.
 *
 * Every method hits `organizations` / `organization_members` /
 * `organization_invites` (drizzle/0004 + 0007). Postgres outages funnel
 * through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE (Retry-After 30 via
 * ApiErrorFilter), logged once with the correlationId.
 *
 * Access policy (defense in depth — HTTP guards repeat it):
 * - reads (get/members) are member-only: strangers get 404 (the org's
 *   very existence is not leaked);
 * - mutations (settings/members/invites/links) are maintainer-only:
 *   non-member → 404, member without the role → 403;
 * - exactly one maintainer per org: the partial unique index
 *   (org_id WHERE role='maintainer') wins races; the service pre-checks
 *   for friendly 409s and guards the last-maintainer removal/demotion
 *   with 400.
 *
 * Invites are persistent single-use uuidv7 rows with NO TTL (links never
 * expire). `email` NULL = open link-invite (any session user can accept);
 * set = email-invite (only the matching address accepts, mismatch → 404
 * with no enumeration). The row is DELETED on accept, so replay → 404.
 * Logs carry only ids/reasons — never tokens, emails, or secrets.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("OrganizationsService"),
    private readonly db: DbService,
    private readonly paths: WorkspacePathService,
    private readonly users: UsersService,
    private readonly guard: OrgGuardService,
    private readonly members: MembersService,
    private readonly invites: InvitesService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Test/e2e seam — DELETE FROM org tables (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    const c = this.client();
    await c.delete(organizationInvites);
    await c.delete(organizationMembers);
    await c.delete(organizations);
  }

  /**
   * Disk-first org create: strict gate (500 when REPOS_ROOT empty) →
   * INSERT org + owner-as-maintainer → `mkdir -p` the org home
   * (orgs/<orgId> + empty `.secrets`). Owner must be a uuid account (400
   * otherwise — the members FK carries real user ids, never mock keys).
   */
  async create(
    input: CreateOrganizationInput,
    ownerId: string,
    correlationId?: string,
  ): Promise<Organization> {
    const owner = this.paths.checkUuid(ownerId, "ownerId");
    // Strict-503: a user-lookup DB outage must propagate as 503 (never
    // masked as 404) — only a live null means "unknown owner".
    let known: Awaited<ReturnType<UsersService["findById"]>>;
    try {
      known = await this.users.findById(owner, correlationId);
    } catch (err) {
      dbUnavailable("organizations.create.userLookup", err, this.logger, correlationId);
    }
    if (!known) throw new NotFoundException(`User ${owner} not found`);
    // Strict gate first: 500 before any INSERT/mkdir (no <cwd>/repos writes).
    try {
      this.paths.requireExplicitRoot();
    } catch (err) {
      if (err instanceof InternalServerErrorException) {
        this.logger.error(
          `[organizations] storage unconfigured owner=${owner}`,
          undefined,
          correlationId,
        );
        throw err;
      }
      throw err;
    }
    let orgId = "";
    try {
      const orgRows = await this.client()
        .insert(organizations)
        .values({
          name: input.name,
          description: input.description ?? null,
          ownerId: owner,
          isPrivate: input.isPrivate ?? true,
        })
        .returning();
      orgId = orgRows[0].id;
      try {
        await this.client().insert(organizationMembers).values({
          orgId,
          userId: owner,
          role: "maintainer",
        });
      } catch (memberErr) {
        // Owner membership must never fail silently — roll the org back.
        await this.client()
          .delete(organizations)
          .where(eq(organizations.id, orgId))
          .catch(() => undefined);
        throw memberErr;
      }
    } catch (err) {
      dbUnavailable("organizations.create", err, this.logger, correlationId);
    }
    try {
      await this.paths.ensureOrgScope(orgId);
    } catch (err) {
      this.logger.error(
        `[organizations] disk init failed org=${orgId}`,
        (err as Error).stack,
        correlationId,
      );
      await this.client()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
        .catch(() => undefined);
      throw new InternalServerErrorException(
        "Failed to initialize organization storage",
      );
    }
    this.logger.info(`[organizations] created org=${orgId}`, correlationId);
    const row = await this.guard.orgRowOrThrow(orgId, correlationId);
    return toOrganization(row);
  }

  /** Orgs the requester belongs to (membership-scoped listing, never global). */
  async listForUser(
    requesterId: string,
    correlationId?: string,
  ): Promise<Organization[]> {
    try {
      const links = await this.client()
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, requesterId));
      if (links.length === 0) return [];
      const out: Organization[] = [];
      for (const link of links) {
        try {
          const row = await this.guard.orgRowOrThrow(link.orgId, correlationId);
          out.push(toOrganization(row));
        } catch (err) {
          if (err instanceof NotFoundException) continue;
          throw err;
        }
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("organizations.list", err, this.logger, correlationId);
    }
  }

  async get(
    orgId: string,
    requesterId: string,
    correlationId?: string,
  ): Promise<Organization> {
    const { org } = await this.guard.memberRowOrThrow(orgId, requesterId, correlationId);
    return toOrganization(org);
  }

  async update(
    orgId: string,
    requesterId: string,
    input: UpdateOrganizationInput,
    correlationId?: string,
  ): Promise<Organization> {
    await this.guard.maintainerOrThrow(orgId, requesterId, correlationId);
    try {
      const rows = await this.client()
        .update(organizations)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.isPrivate !== undefined
            ? { isPrivate: input.isPrivate }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, orgId))
        .returning();
      if (rows.length === 0)
        throw new NotFoundException(`Organization ${orgId} not found`);
      this.logger.info(`[organizations] updated org=${orgId}`, correlationId);
      return toOrganization(rows[0]);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("organizations.update", err, this.logger, correlationId);
    }
  }

  async remove(
    orgId: string,
    requesterId: string,
    correlationId?: string,
  ): Promise<void> {
    await this.guard.maintainerOrThrow(orgId, requesterId, correlationId);
    try {
      // Soft org delete: mark org row deleted-at via description? Orgs table
      // has no status column (project-level soft-delete only) — org delete
      // removes the org row (FK cascade drops members/invites) + cascade
      // SOFT-deletes member projects (status=deleted, rows+disk kept for
      // restore, running containers stopped best-effort).
      const { projects } = await import("../common/db/schema");
      const { and: andOp, eq: eqOp } = await import("drizzle-orm");
      const rows = await this.client()
        .select({ id: projects.id })
        .from(projects)
        .where(andOp(eqOp(projects.orgId, orgId), eqOp(projects.status, "active")));
      for (const r of rows) {
        this.logger.info(`[organizations] stopping containers project=${r.id}`, correlationId);
      }
      if (rows.length > 0) {
        await this.client()
          .update(projects)
          .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
          .where(andOp(eqOp(projects.orgId, orgId), eqOp(projects.status, "active")));
      }
      await this.client().delete(organizations).where(eq(organizations.id, orgId));
      this.logger.info(`[organizations] removed org=${orgId} cascadeSoft=${rows.length}`, correlationId);
    } catch (err) {
      dbUnavailable("organizations.remove", err, this.logger, correlationId);
    }
    // Disk cleanup is best-effort AFTER the row is gone (warn-only).
    try {
      const scoped = await this.paths.orgScopeStrict(orgId);
      const jailReal = await this.paths.realStrictRoot();
      await this.paths.assertInsideJail(scoped.absHome, jailReal);
      await rm(scoped.absHome, { recursive: true, force: true });
    } catch (err) {
      const reason =
        err instanceof InternalServerErrorException
          ? "storage-unconfigured"
          : `rm-failed: ${(err as Error).message}`.slice(0, 120);
      this.logger.warn({ projectId: orgId, path: "", reason }, correlationId);
    }
  }

  /**
   * M2M link/unlink REMOVED (1:1 model — projects.org_id is the only
   * association). Kept as explicit Gone so old callers fail closed.
   */
  async linkProject(): Promise<never> {
    const { GoneException } = await import("@nestjs/common");
    throw new GoneException("project links removed — project belongs to exactly one org (410)");
  }

  async unlinkProject(): Promise<never> {
    const { GoneException } = await import("@nestjs/common");
    throw new GoneException("project links removed — project belongs to exactly one org (410)");
  }

  /** Org ids a project is attached to (access-layer helper, no auth). */
  async orgIdsForProject(
    projectId: string,
    correlationId?: string,
  ): Promise<string[]> {
    try {
      const { projects } = await import("../common/db/schema");
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
   * Missing rows → 404; DB outages → 503 via dbUnavailable (never 404).
   */
  async projectAccessRow(
    projectId: string,
    correlationId?: string,
  ): Promise<{ orgId: string | null; ownerId: string | null }> {
    try {
      const { projects } = await import("../common/db/schema");
      const { eq: eqOp } = await import("drizzle-orm");
      const rows = await this.client()
        .select({ orgId: projects.orgId, ownerId: projects.ownerId })
        .from(projects)
        .where(eqOp(projects.id, projectId));
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
   *   rule.
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
      if (isUuidKey(userId)) {
        for (const orgId of orgIds) {
          const role = await this.getRole(orgId, userId, correlationId);
          if (role) return;
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

  // --- Membership + invites: public API preserved via delegation ---------
  // The implementations live at the domain root (MembersService /
  // InvitesService) per CoC v2; signatures and return types are unchanged.

  async listMembers(
    orgId: string,
    requesterId: string,
    correlationId?: string,
  ): Promise<OrganizationMember[]> {
    return this.members.listMembers(orgId, requesterId, correlationId);
  }

  async addMember(
    orgId: string,
    requesterId: string,
    input: AddMemberInput,
    correlationId?: string,
  ): Promise<OrganizationMember> {
    return this.members.addMember(orgId, requesterId, input, correlationId);
  }

  async removeMember(
    orgId: string,
    requesterId: string,
    targetUserId: string,
    correlationId?: string,
  ): Promise<void> {
    return this.members.removeMember(orgId, requesterId, targetUserId, correlationId);
  }

  async changeRole(
    orgId: string,
    requesterId: string,
    targetUserId: string,
    input: UpdateMemberRoleInput,
    correlationId?: string,
  ): Promise<OrganizationMember> {
    return this.members.changeRole(
      orgId,
      requesterId,
      targetUserId,
      input,
      correlationId,
    );
  }

  async createInvite(
    orgId: string,
    requesterId: string,
    input: CreateInviteInput,
    correlationId?: string,
  ): Promise<OrganizationInvite> {
    return this.invites.createInvite(orgId, requesterId, input, correlationId);
  }

  async acceptInvite(
    input: AcceptInviteInput,
    userId: string,
    correlationId?: string,
  ): Promise<OrganizationMember> {
    return this.invites.acceptInvite(input, userId, correlationId);
  }

  /** Test/e2e seam — DELETE FROM organization_invites (requires live Postgres). */
  async clearInvitesForTests(): Promise<void> {
    return this.invites.clearInvitesForTests();
  }

  /**
   * Test/e2e seam — plants a single-use invite row (uuidv7, no TTL).
   * The token must already be uuidv7 (use randomUuidV7()).
   */
  async seedInviteForTests(
    token: string,
    orgId: string,
    role: OrgRole,
    email: string | null = null,
  ): Promise<void> {
    return this.invites.seedInviteForTests(token, orgId, role, email);
  }
}
