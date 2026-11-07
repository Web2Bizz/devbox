import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { AppLogger } from "../common/logger";
import { DbService, dbUnavailable, type DbClient } from "../common/db/db.service";
import {
  organizationInvites,
  organizationMembers,
  organizations,
  projectChats,
  projectSessions,
  projects,
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
} from "./organizations.dto";
import { InvitesService } from "./modules/invites/invites.service";
import { MembersService } from "./modules/members/members.service";
import { OrganizationsGuard } from "./organizations.guard";
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
    isPersonal: row.isPersonal ?? false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * OrganizationsService — Postgres-backed org registry (strict, no memory
 * fallback) with disk-backed org homes (orgs/<orgId>/.secrets).
 *
 * Owns org CRUD (`organizations`) and the shared test seams. Membership
 * lives in MembersService (MembersModule) and invites in InvitesService
 * (InvitesModule) — nested modules under `organizations/modules/` per CoC §2;
 * the org access gate is OrganizationsGuard (domain root, still injected
 * here for CRUD). The project-level C4 gate (`projects.org_id`, the 1:1
 * model) moved to projects/modules/project-access
 * (ProjectAccessService, exported by ProjectsModule). The
 * membership/invite methods below are one-line delegates so the public API
 * is unchanged. Pure helpers live in `utils/` (pg-error,
 * organization-member) — SQL/tables are unchanged.
 *
 * Every method hits `organizations` / `organization_members` /
 * `organization_invites` (see `common/db/schema.ts`). Postgres outages funnel
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
    private readonly logger: AppLogger = new AppLogger(OrganizationsService.name),
    private readonly db: DbService,
    private readonly paths: WorkspacePathService,
    private readonly users: UsersService,
    private readonly guard: OrganizationsGuard,
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
    // Dependent rows first: project_chats/project_sessions and projects.org_id
    // are ON DELETE RESTRICT (hard deletes must fail in production), so this
    // test-only cleanup removes them explicitly before the projects/orgs.
    await c.delete(organizationInvites);
    await c.delete(organizationMembers);
    await c.delete(projectSessions);
    await c.delete(projectChats);
    await c.delete(projects);
    await c.delete(organizations);
  }

  /**
   * Disk-first org create: strict gate (500 when REPOS_ROOT empty) →
   * INSERT org + owner-as-maintainer → `mkdir -p` the org home
   * (orgs/<orgId> + empty `.secrets`). Owner must be a uuid account (400
   * otherwise — the members FK carries real user ids, never mock keys).
   * `input.isPersonal` marks the per-user personal org (default false).
   */
  async create(
    input: CreateOrganizationInput & { isPersonal?: boolean },
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
      // Org + owner-as-maintainer are one unit: the transaction rolls the
      // org back if the membership insert fails (no compensating DELETE).
      orgId = await this.client().transaction(async (tx) => {
        const orgRows = await tx
          .insert(organizations)
          .values({
            name: input.name,
            description: input.description ?? null,
            ownerId: owner,
            isPrivate: input.isPrivate ?? true,
            isPersonal: input.isPersonal ?? false,
          })
          .returning();
        const id = orgRows[0].id;
        await tx.insert(organizationMembers).values({
          orgId: id,
          userId: owner,
          role: "maintainer",
        });
        return id;
      });
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
      // No physical delete: hide the half-created row with a soft delete
      // (project rule — rows are never physically removed).
      try {
        const now = new Date();
        await this.client()
          .update(organizations)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(organizations.id, orgId));
      } catch (rollbackErr) {
        dbUnavailable(
          "organizations.create.diskRollback",
          rollbackErr,
          this.logger,
          correlationId,
        );
      }
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
  ): Promise<Array<Organization>> {
    try {
      const links = await this.client()
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, requesterId));
      if (links.length === 0) return [];
      const out: Array<Organization> = [];
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
    const gate = await this.guard.maintainerOrThrow(orgId, requesterId, correlationId);
    if (gate.org.isPersonal) {
      throw new BadRequestException({
        code: "personal_org_immutable",
        message: "Personal organization cannot be deleted",
      });
    }
    let cascadedProjects = 0;
    try {
      // Soft org delete (project rule: DB rows are NEVER physically
      // removed). One transaction marks the org and its still-live projects
      // with `deleted_at = now()`. Chats and sessions are left untouched —
      // they are part of the projects' history and hide together with the
      // project reads. No container stop happens on this path (the old
      // "stopping containers" log had no docker call behind it).
      const now = new Date();
      await this.client().transaction(async (tx) => {
        await tx
          .update(organizations)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(organizations.id, orgId));
        const rows = await tx
          .update(projects)
          .set({ status: "deleted", deletedAt: now, updatedAt: now })
          .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
          .returning({ id: projects.id });
        cascadedProjects = rows.length;
      });
      this.logger.info(
        `[organizations] soft-removed org=${orgId} cascadeSoft=${cascadedProjects}`,
        correlationId,
      );
    } catch (err) {
      dbUnavailable("organizations.remove", err, this.logger, correlationId);
    }
    // The org home (orgs/<orgId>) is kept: restore promises live project data.
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

  // --- Membership + invites: public API preserved via delegation ---------
  // The implementations live in the nested modules (MembersModule /
  // InvitesModule, CoC §2); signatures and return types are unchanged.

  async listMembers(
    orgId: string,
    requesterId: string,
    correlationId?: string,
  ): Promise<Array<OrganizationMember>> {
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
   * The token must already be uuidv7 (use Bun.randomUUIDv7()).
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
