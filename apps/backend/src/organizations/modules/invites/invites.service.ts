import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { AppLogger } from "../../../common/logger";
import { DbService, dbUnavailable, type DbClient } from "../../../common/db/db.service";
import {
  organizationInvites,
  organizationMembers,
  type OrganizationInviteRow,
} from "../../../common/db/schema";
import { WorkspacePathService } from "../../../common/storage/workspace-path.service";
import { UsersService } from "../../../users/users.service";
import type { AcceptInviteInput, CreateInviteInput } from "../../dto";
import type {
  OrganizationInvite,
  OrganizationMember,
  OrgRole,
} from "../../organizations.types";
import { OrganizationsGuard } from "../../organizations.guard";
import { toMember } from "../../utils/organization-member";
import { isPgForeignKeyViolation, isPgUniqueViolation } from "../../utils/pg-error";

/**
 * uuidv7 shape (version 7 + RFC 4122 variant) — a non-v7 token can never
 * match a row, so it is rejected before any Postgres access.
 */
function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * InvitesService — persistent single-use uuidv7 invite links backed by
 * `organization_invites` (drizzle/0007). Extracted verbatim from
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
    private readonly logger: AppLogger = new AppLogger("InvitesService"),
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
   * accept (row deleted) or org deletion (cascade). `email` binds the
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
    const role = (input.role ?? "user") as OrgRole;
    if (role === "maintainer" && (await this.guard.maintainerCount(orgId, correlationId)) > 0) {
      throw new ConflictException("Organization already has a maintainer");
    }
    const rawEmail =
      typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const email = rawEmail ? rawEmail : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException("email must be a valid email");
    }
    const token = Bun.randomUUIDv7();
    try {
      const rows = await this.client()
        .insert(organizationInvites)
        .values({ token, orgId, email, role })
        .returning();
      this.logger.info(`[organizations] invite created org=${orgId} role=${role}`, correlationId);
      return this.toInvite(rows[0]);
    } catch (err) {
      if (isPgForeignKeyViolation(err)) {
        throw new NotFoundException(`Organization ${orgId} not found`);
      }
      dbUnavailable("organizations.createInvite", err, this.logger, correlationId);
    }
  }

  /**
   * Accept a persistent single-use invite. Missing/consumed → 404 (no
   * enumeration, no expiry — links never expire). The row is DELETED
   * before the membership insert result returns, so replay → 404 and a
   * raced accept can never grant membership twice.
   */
  async acceptInvite(
    input: AcceptInviteInput,
    userId: string,
    correlationId?: string,
  ): Promise<OrganizationMember> {
    const me = this.paths.checkUuid(userId, "userId");
    const token = String(input.token ?? "").trim().toLowerCase();
    if (!isUuidV7(token)) {
      throw new NotFoundException("Invite not found or already used");
    }
    let stored: OrganizationInviteRow | null = null;
    try {
      const rows = await this.client()
        .select()
        .from(organizationInvites)
        .where(eq(organizationInvites.token, token))
        .limit(1);
      stored = rows[0] ?? null;
    } catch (err) {
      dbUnavailable("organizations.acceptInvite.lookup", err, this.logger, correlationId);
    }
    if (!stored) {
      throw new NotFoundException("Invite not found or already used");
    }
    // Strict-503 (see OrganizationsService.create()): DB outage propagates,
    // live null → 404.
    let known: Awaited<ReturnType<UsersService["findById"]>>;
    try {
      known = await this.users.findById(me, correlationId);
    } catch (err) {
      dbUnavailable("organizations.acceptInvite.userLookup", err, this.logger, correlationId);
    }
    if (!known) throw new NotFoundException(`User ${me} not found`);
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
      const rows = await this.client()
        .insert(organizationMembers)
        .values({ orgId: stored.orgId, userId: me, role: stored.role as OrgRole })
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
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new ConflictException(
          stored.role === "maintainer"
            ? "Organization already has a maintainer"
            : "User is already a member",
        );
      }
      if (isPgForeignKeyViolation(err)) {
        throw new NotFoundException("Organization or user not found");
      }
      dbUnavailable("organizations.acceptInvite", err, this.logger, correlationId);
    }
  }
}
