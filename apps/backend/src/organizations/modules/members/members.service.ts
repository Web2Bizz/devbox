import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { AppLogger } from "../../../common/logger";
import { DbService, dbUnavailable, type DbClient } from "../../../common/db/db.service";
import {
  organizationMembers,
  type OrganizationMemberRow,
} from "../../../common/db/schema";
import { WorkspacePathService } from "../../../common/storage/workspace-path.service";
import { UsersService } from "../../../users/users.service";
import type { AddMemberInput, UpdateMemberRoleInput } from "../../organizations.dto";
import type { OrganizationMember, OrgRole } from "../../organizations.types";
import { OrganizationsGuard } from "../../organizations.guard";
import { toMember } from "../../utils/organization-member";
import { isPgForeignKeyViolation, isPgUniqueViolation } from "../../utils/pg-error";

/**
 * MembersService — org membership (list/add/remove/change-role) backed by
 * `organization_members` (drizzle/0004; partial unique single-maintainer
 * index). Extracted verbatim from OrganizationsService (phase 3, CoC v2);
 * the access gate comes from OrganizationsGuard. Lives in MembersModule
 * (`organizations/modules/members/`, CoC §2) — imported by
 * OrganizationsModule, never registered in AppModule.
 *
 * Access policy: reads are member-only (404 for strangers), mutations are
 * maintainer-only (403 for plain members), the last maintainer can never be
 * removed or demoted (400), and a second maintainer is a 409 (pre-check +
 * partial unique index for races).
 *
 * Postgres outages funnel through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30 via ApiErrorFilter), logged once with the correlationId.
 * Logs carry only ids/roles — never tokens, emails, or secrets.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("MembersService"),
    private readonly db: DbService,
    private readonly paths: WorkspacePathService,
    private readonly users: UsersService,
    private readonly guard: OrganizationsGuard,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  async listMembers(
    orgId: string,
    requesterId: string,
    correlationId?: string,
  ): Promise<OrganizationMember[]> {
    await this.guard.memberRowOrThrow(orgId, requesterId, correlationId);
    try {
      const rows = await this.client()
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.orgId, orgId));
      return rows
        .map(toMember)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (err) {
      dbUnavailable("organizations.members", err, this.logger, correlationId);
    }
  }

  async addMember(
    orgId: string,
    requesterId: string,
    input: AddMemberInput,
    correlationId?: string,
  ): Promise<OrganizationMember> {
    await this.guard.maintainerOrThrow(orgId, requesterId, correlationId);
    const target = this.paths.checkUuid(input.userId, "userId");
    const role = (input.role ?? "user") as OrgRole;
    // Strict-503 (see OrganizationsService.create()): DB outage propagates,
    // live null → 404.
    let known: Awaited<ReturnType<UsersService["findById"]>>;
    try {
      known = await this.users.findById(target, correlationId);
    } catch (err) {
      dbUnavailable("organizations.addMember.userLookup", err, this.logger, correlationId);
    }
    if (!known) throw new NotFoundException(`User ${target} not found`);
    if (role === "maintainer" && (await this.guard.maintainerCount(orgId, correlationId)) > 0) {
      throw new ConflictException("Organization already has a maintainer");
    }
    try {
      const rows = await this.client()
        .insert(organizationMembers)
        .values({ orgId, userId: target, role })
        .returning();
      this.logger.info(
        `[organizations] member added org=${orgId} role=${role}`,
        correlationId,
      );
      return toMember(rows[0]);
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        // Duplicate (org,user) or a raced second maintainer → 409.
        throw new ConflictException(
          role === "maintainer"
            ? "Organization already has a maintainer"
            : "User is already a member",
        );
      }
      if (isPgForeignKeyViolation(err)) {
        throw new NotFoundException(`User ${target} not found`);
      }
      dbUnavailable("organizations.addMember", err, this.logger, correlationId);
    }
  }

  async removeMember(
    orgId: string,
    requesterId: string,
    targetUserId: string,
    correlationId?: string,
  ): Promise<void> {
    await this.guard.maintainerOrThrow(orgId, requesterId, correlationId);
    const target = this.paths.checkUuid(targetUserId, "userId");
    let row: OrganizationMemberRow | null = null;
    try {
      const rows = await this.client()
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, target),
          ),
        )
        .limit(1);
      row = rows[0] ?? null;
    } catch (err) {
      dbUnavailable(
        "organizations.removeMember.lookup",
        err,
        this.logger,
        correlationId,
      );
    }
    if (!row) throw new NotFoundException(`Member ${target} not found`);
    if (
      (row.role as OrgRole) === "maintainer" &&
      (await this.guard.maintainerCount(orgId, correlationId)) <= 1
    ) {
      throw new BadRequestException("Cannot remove the last maintainer");
    }
    try {
      await this.client()
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, target),
          ),
        );
      this.logger.info(`[organizations] member removed org=${orgId}`, correlationId);
    } catch (err) {
      dbUnavailable(
        "organizations.removeMember",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  async changeRole(
    orgId: string,
    requesterId: string,
    targetUserId: string,
    input: UpdateMemberRoleInput,
    correlationId?: string,
  ): Promise<OrganizationMember> {
    await this.guard.maintainerOrThrow(orgId, requesterId, correlationId);
    const target = this.paths.checkUuid(targetUserId, "userId");
    const next = input.role as OrgRole;
    let row: OrganizationMemberRow | null = null;
    try {
      const rows = await this.client()
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, target),
          ),
        )
        .limit(1);
      row = rows[0] ?? null;
    } catch (err) {
      dbUnavailable(
        "organizations.changeRole.lookup",
        err,
        this.logger,
        correlationId,
      );
    }
    if (!row) throw new NotFoundException(`Member ${target} not found`);
    const current = row.role as OrgRole;
    if (current === next) return toMember(row);
    if (
      current === "maintainer" &&
      next === "user" &&
      (await this.guard.maintainerCount(orgId, correlationId)) <= 1
    ) {
      throw new BadRequestException("Cannot demote the last maintainer");
    }
    if (
      current === "user" &&
      next === "maintainer" &&
      (await this.guard.maintainerCount(orgId, correlationId)) > 0
    ) {
      throw new ConflictException("Organization already has a maintainer");
    }
    try {
      const rows = await this.client()
        .update(organizationMembers)
        .set({ role: next, updatedAt: new Date() })
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, target),
          ),
        )
        .returning();
      this.logger.info(
        `[organizations] role changed org=${orgId} role=${next}`,
        correlationId,
      );
      return toMember(rows[0]);
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new ConflictException("Organization already has a maintainer");
      }
      dbUnavailable("organizations.changeRole", err, this.logger, correlationId);
    }
  }
}
