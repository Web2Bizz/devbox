import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { AppLogger } from "@common/logger";
import { DbService, dbUnavailable, type DbClient } from "@common/db/db.service";
import {
  organizationInvites,
  organizationMembers,
  type OrganizationInviteRow,
  type OrganizationMemberRow,
} from "@common/db/schema";
import { WorkspacePathService } from "@common/storage/workspace-path.service";
import { uuidV7Schema } from "@common/validation";
import { UsersService } from "@users/users.service";
import type { StoredUser } from "@users/users.types";
import type { AcceptInviteInput, CreateInviteInput } from "../../organizations.dto";
import type {
  OrganizationInvite,
  OrganizationMember,
  OrgRole,
} from "../../organizations.types";
import { OrganizationsGuard } from "../../organizations.guard";
import { toMember } from "../../utils/organization-member";
import { isPgForeignKeyViolation, isPgUniqueViolation } from "../../utils/pg-error";

/**
 * InvitesService — persistent single-use uuidv7 invite links backed by
 * `organization_invites` (see `common/db/schema.ts`). Extracted verbatim from
 * OrganizationsService (phase 3, CoC v2); the access gate comes from
 * OrganizationsGuard. Lives in InvitesModule
 * (`organizations/modules/invites/`, CoC §2) — imported by
 * OrganizationsModule, never registered in AppModule.
 *
 * Invites have NO TTL (links never expire). `email` NULL = open link-invite
 * (any session user can accept); set = email-invite (only the matching
 * address accepts, mismatch → 404 with no enumeration). The row is DELETED
 * on accept, so replay → 404 and a raced accept can never grant membership
 * twice.
 *
 * Postgres outages funnel through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30 via ApiErrorFilter), logged once with the correlationId.
 * Logs carry only ids/roles — never tokens, emails, or secrets.
 */
@Injectable()
export class InvitesService {
  constructor(
    private readonly logger: AppLogger = new AppLogger(InvitesService.name),
    private readonly db: DbService,
    private readonly paths: WorkspacePathService,
    private readonly users: UsersService,
    private readonly guard: OrganizationsGuard,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Row → wire codec for `organization_invites` (token stays opaque). */
  private toInvite(row: OrganizationInviteRow): OrganizationInvite {
    return {
      token: row.token,
      orgId: row.orgId,
      email: row.email,
      role: row.role as OrgRole,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Test/e2e seam — DELETE FROM organization_invites (requires live Postgres). */
  async clearInvitesForTests(): Promise<void> {
    await this.client().delete(organizationInvites);
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
    await this.client().insert(organizationInvites).values({
      token,
      orgId,
      email,
      role,
    });
  }

  /**
   * Mint a persistent single-use invite (maintainer-only, no TTL).
   * The uuidv7 token is returned ONCE (never logged) and lives until
   * accept (row deleted); a soft-deleted org (deleted_at set) is treated as
   * missing, so its pending invites can never grant access. `email` binds the
   * invite to one address (lowercased, mismatch → 404); absent = open
   * link-invite for any session user.
   */
  async createInvite(
    orgId: string,
    requesterId: string,
    input: CreateInviteInput,
    correlationId?: string,
  ): Promise<OrganizationInvite> {
    await this.guard.maintainerOrThrow(orgId, requesterId, correlationId);
    const role: OrgRole = (input.role ?? "user") as OrgRole;
    if (role === "maintainer" && (await this.guard.maintainerCount(orgId, correlationId)) > 0) {
      throw new ConflictException("Organization already has a maintainer");
    }
    const rawEmail: string =
      typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const email: string | null = rawEmail ? rawEmail : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException("email must be a valid email");
    }
    const token: string = Bun.randomUUIDv7();
    try {
      const rows: Array<OrganizationInviteRow> = await this.client()
        .insert(organizationInvites)
        .values({ token, orgId, email, role })
        .returning();
      this.logger.info(`[organizations] invite created org=${orgId} role=${role}`, correlationId);
      return this.toInvite(rows[0]);
    } catch (error) {
      if (isPgForeignKeyViolation(error)) {
        throw new NotFoundException(`Organization ${orgId} not found`);
      }
      dbUnavailable("organizations.createInvite", error, this.logger, correlationId);
    }
  }

  /**
   * Accept a persistent single-use invite. Missing/consumed → 404 (no
   * enumeration, no expiry — links never expire). A non-v7 token can never
   * match a row, so it is rejected before any Postgres access. The row is
   * DELETED
   * before the membership insert result returns, so replay → 404 and a
   * raced accept can never grant membership twice.
   */
  async acceptInvite(
    input: AcceptInviteInput,
    userId: string,
    correlationId?: string,
  ): Promise<OrganizationMember> {
    const acceptingUserId: string = this.paths.checkUuid(userId, "userId");
    const token: string = String(input.token ?? "").trim().toLowerCase();
    if (!uuidV7Schema.safeParse(token).success) {
      throw new NotFoundException("Invite not found or already used");
    }
    let stored: OrganizationInviteRow | null = null;
    try {
      const rows: Array<OrganizationInviteRow> = await this.client()
        .select()
        .from(organizationInvites)
        .where(eq(organizationInvites.token, token))
        .limit(1);
      stored = rows[0] ?? null;
    } catch (error) {
      dbUnavailable("organizations.acceptInvite.lookup", error, this.logger, correlationId);
    }
    if (!stored) {
      throw new NotFoundException("Invite not found or already used");
    }
    // Soft-deleted org behaves as missing: a pending invite never grants
    // access to an org whose `deleted_at` is set (404, same no-leak rule as
    // the guard).
    await this.guard.orgRowOrThrow(stored.orgId, correlationId);
    // Strict-503 (see OrganizationsService.create()): DB outage propagates,
    // live null → 404.
    let known: StoredUser | null;
    try {
      known = await this.users.findById(acceptingUserId, correlationId);
    } catch (error) {
      dbUnavailable("organizations.acceptInvite.userLookup", error, this.logger, correlationId);
    }
    if (!known) throw new NotFoundException(`User ${acceptingUserId} not found`);
    if (stored.email && known.email.trim().toLowerCase() !== stored.email) {
      throw new NotFoundException("Invite not found or already used");
    }
    if (
      stored.role === "maintainer" &&
      (await this.guard.maintainerCount(stored.orgId, correlationId)) > 0
    ) {
      throw new ConflictException("Organization already has a maintainer");
    }
    try {
      const rows: Array<OrganizationMemberRow> = await this.client()
        .insert(organizationMembers)
        .values({ orgId: stored.orgId, userId: acceptingUserId, role: stored.role as OrgRole })
        .returning();
      await this.client()
        .delete(organizationInvites)
        .where(eq(organizationInvites.token, token))
        .catch(() => undefined);
      this.logger.info(
        `[organizations] invite accepted org=${stored.orgId} role=${stored.role}`,
        correlationId,
      );
      return toMember(rows[0]);
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        throw new ConflictException(
          stored.role === "maintainer"
            ? "Organization already has a maintainer"
            : "User is already a member",
        );
      }
      if (isPgForeignKeyViolation(error)) {
        throw new NotFoundException("Organization or user not found");
      }
      dbUnavailable("organizations.acceptInvite", error, this.logger, correlationId);
    }
  }
}
