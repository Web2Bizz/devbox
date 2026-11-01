import {
  InternalServerErrorException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { AppLogger } from "../common/logger";
import { DbService, dbUnavailable, type DbClient } from "../common/db/db.service";
import {
  organizationInvites,
  organizationMembers,
  organizations,
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
import { OrgGuardService } from "./org-guard.service";
import { ProjectAccessService } from "./projects/access/project-access.service";
import { MembersService } from "./members/members.service";
import { InvitesService } from "./invites/invites.service";
import {
  toOrganization,
  type OrgRole,
  type Organization,
  type OrganizationInvite,
  type OrganizationMember,
} from "./organizations.types";

export type {
  OrgRole,
  Organization,
  OrganizationInvite,
  OrganizationMember,
} from "./organizations.types";
export { isUuidV7, randomUuidV7 } from "./organizations.types";

/**
 * OrganizationsService — Postgres-backed org registry (strict, no memory
 * fallback) with disk-backed org homes (orgs/<orgId>/.secrets).
 *
 * Every method hits `organizations` / `organization_members` /
 * `projects_and_organizations` / `organization_invites`
 * (drizzle/0004 + 0007). Postgres outages funnel through `dbUnavailable`
 * → 503 EXTERNAL_UNAVAILABLE (Retry-After 30 via ApiErrorFilter), logged
 * once with the correlationId.
 *
 * Phase 3 split the file, not the behaviour: membership ops live in
 * `members/MembersService`, invite ops in `invites/InvitesService`, shared
 * role gates in `OrgGuardService`. This service keeps the public surface
 * (controllers/tests/callers unchanged) and delegates; org CRUD, the disk
 * scope and the C4 project gate stay here.
 *
 * Access policy (defense in depth — HTTP guards repeat it):
 * - reads (get/members) are member-only: strangers get 404 (the org's
 *   very existence is not leaked);
 * - mutations (settings/members/invites/links) are maintainer-only:
 *   non-member → 404, member without the role → 403;
 * - exactly one maintainer per org: the partial unique index
 *   (org_id WHERE role='maintainer') wins races; the services pre-check
 *   for friendly 409s and guard the last-maintainer removal/demotion
 *   with 400.
 *
 * Logs carry only ids/reasons — never tokens, emails, or secrets.
 */
@Injectable()
export class OrganizationsService {
  private readonly guard: OrgGuardService;
  private readonly members: MembersService;
  private readonly invites: InvitesService;
  private readonly access: ProjectAccessService;

  constructor(
    private readonly logger: AppLogger = new AppLogger("OrganizationsService"),
    private readonly db: DbService,
    private readonly paths: WorkspacePathService,
    private readonly users: UsersService,
  ) {
    this.guard = new OrgGuardService(this.logger, this.db);
    this.members = new MembersService(
      this.logger,
      this.paths,
      this.users,
      this.guard,
    );
    this.invites = new InvitesService(
      this.logger,
      this.paths,
      this.users,
      this.guard,
    );
    this.access = new ProjectAccessService(this.logger, this.db, this.guard);
  }

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Test/e2e seam — DELETE FROM organization_invites (requires live Postgres). */
  async clearInvitesForTests(): Promise<void> {
    await this.invites.clearInvitesForTests();
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
    await this.invites.seedInviteForTests(token, orgId, role, email);
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
      await this.paths.removeDir(scoped.absHome);
    } catch (err) {
      const reason =
        err instanceof InternalServerErrorException
          ? "storage-unconfigured"
          : `rm-failed: ${(err as Error).message}`.slice(0, 120);
      this.logger.warn({ projectId: orgId, path: "", reason }, correlationId);
    }
  }

  // --- membership (delegates to members/MembersService) --------------------

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

  // --- invites (delegates to invites/InvitesService) -----------------------

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

  // --- project access (delegates to organizations/projects/access) ---------

  /** Org ids a project is attached to (access-layer helper, no auth). */
  async orgIdsForProject(
    projectId: string,
    correlationId?: string,
  ): Promise<string[]> {
    return this.access.orgIdsForProject(projectId, correlationId);
  }

  /** Null for strangers (access-layer helper — callers map null → 404). */
  async getRole(
    orgId: string,
    userId: string,
    correlationId?: string,
  ): Promise<OrgRole | null> {
    return this.access.getRole(orgId, userId, correlationId);
  }

  /** Project row loader for project-scoped callers (C4 gate helper). */
  async projectAccessRow(
    projectId: string,
    correlationId?: string,
  ): Promise<{ orgId: string | null; ownerId: string | null }> {
    return this.access.projectAccessRow(projectId, correlationId);
  }

  /** C4 project-id gate — see ProjectAccessService.assertProjectAccessById. */
  async assertProjectAccessById(
    projectId: string,
    userId: string,
    correlationId?: string,
  ): Promise<{ ownerId: string | null; orgIds: string[] }> {
    return this.access.assertProjectAccessById(projectId, userId, correlationId);
  }

  /** Shared project access gate — see ProjectAccessService.assertProjectAccess. */
  async assertProjectAccess(
    projectId: string,
    ownerId: string | null,
    userId: string,
    correlationId?: string,
  ): Promise<void> {
    return this.access.assertProjectAccess(
      projectId,
      ownerId,
      userId,
      correlationId,
    );
  }
}
