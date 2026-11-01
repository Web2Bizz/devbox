import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { AppLogger } from "../../common/logger";
import { dbUnavailable } from "../../common/db/db.service";
import {
  organizationInvites,
  organizationMembers,
  type OrganizationInviteRow,
} from "../../common/db/schema";
import { UsersService } from "../../users/users.service";
import { WorkspacePathService } from "../../common/storage/workspace-path.service";
import type { AcceptInviteInput, CreateInviteInput } from "../dto";
import type { OrgGuardService } from "../org-guard.service";
import {
  isPgForeignKeyViolation,
  isPgUniqueViolation,
  isUuidV7,
  randomUuidV7,
  toInvite,
  toMember,
  type OrgRole,
  type OrganizationInvite,
  type OrganizationMember,
} from "../organizations.types";

/**
 * InvitesService — persistent single-use uuidv7 invites (no TTL).
 *
 * Extracted from OrganizationsService in phase 3; SQL/tables unchanged
 * (`organization_invites`, token-PK single-use). `email` NULL = open
 * link-invite (any session user can accept); set = email-invite (only the
 * matching address accepts, mismatch → 404 with no enumeration). The row
 * is DELETED on accept, so replay → 404. Logs carry only ids/reasons —
 * never tokens, emails, or secrets.
 */
@Injectable()
export class InvitesService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("InvitesService"),
    private readonly paths: WorkspacePathService,
    private readonly users: UsersService,
    private readonly guard: OrgGuardService,
  ) {}

  /** Test/e2e seam — DELETE FROM organization_invites (requires live Postgres). */
  async clearInvitesForTests(): Promise<void> {
    await this.guard.client().delete(organizationInvites);
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
    await this.guard.client().insert(organizationInvites).values({
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
    const token = randomUuidV7();
    try {
      const rows = await this.guard
        .client()
        .insert(organizationInvites)
        .values({ token, orgId, email, role })
        .returning();
      this.logger.info(`[organizations] invite created org=${orgId} role=${role}`, correlationId);
      return toInvite(rows[0]);
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
      const rows = await this.guard
        .client()
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
    // Strict-503 (see create()): DB outage propagates, live null → 404.
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
      const rows = await this.guard
        .client()
        .insert(organizationMembers)
        .values({ orgId: stored.orgId, userId: me, role: stored.role as OrgRole })
        .returning();
      await this.guard
        .client()
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
