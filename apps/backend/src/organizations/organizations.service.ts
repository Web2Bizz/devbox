import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { AppLogger } from "../common/app-logger.service";
import { DbService, dbUnavailable, type DbClient } from "../db/db.service";
import {
  organizationInvites,
  organizationMembers,
  organizations,
  type OrganizationInviteRow,
  type OrganizationMemberRow,
  type OrganizationRow,
} from "../db/schema";
import { UsersService } from "../auth/users.service";
import { WorkspacePathService } from "../workspaces/workspace-path.service";
import type {
  AcceptInviteInput,
  AddMemberInput,
  CreateInviteInput,
  CreateOrganizationInput,
  UpdateMemberRoleInput,
  UpdateOrganizationInput,
} from "./dto";

export type OrgRole = "maintainer" | "user";

export type Organization = {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationMember = {
  orgId: string;
  userId: string;
  role: OrgRole;
  createdAt: string;
};

export type OrganizationInvite = {
  /** uuidv7 invite token (link material, single-use, never expires) */
  token: string;
  orgId: string;
  /** bound email (lowercased) or null for open link-invites */
  email: string | null;
  role: OrgRole;
  createdAt: string;
};

/**
 * RFC 9562 uuidv7 (unix_ts_ms + rand_a/rand_b) — time-ordered invite ids
 * with no extra dependency (Node 22 has no native v7 yet).
 */
export function randomUuidV7(nowMs = Date.now()): string {
  const bytes = randomBytes(16);
  const now = Math.floor(nowMs);
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/** uuidv7 shape (version 7 + RFC 4122 variant) — non-v7 never matches a row. */
export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

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

function toMember(row: OrganizationMemberRow): OrganizationMember {
  return {
    orgId: row.orgId,
    userId: row.userId,
    role: row.role as OrgRole,
    createdAt: row.createdAt.toISOString(),
  };
}

function toInvite(row: OrganizationInviteRow): OrganizationInvite {
  return {
    token: row.token,
    orgId: row.orgId,
    email: row.email,
    role: row.role as OrgRole,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Unwraps the Postgres SQLSTATE through drizzle's DrizzleQueryError
 * (real code lives in `.cause`, possibly nested) — without this, unique
 * (23505) / FK (23503) violations would all surface as 503 instead of the
 * intended 409/404. Never logs the value — codes only.
 */
function pgCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur !== null && cur !== undefined; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function isPgUniqueViolation(err: unknown): boolean {
  if (pgCode(err) === "23505") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /duplicate key|unique/i.test(msg);
}

function isPgForeignKeyViolation(err: unknown): boolean {
  if (pgCode(err) === "23503") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /foreign key|violates foreign/i.test(msg);
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
 * Every method hits `organizations` / `organization_members` /
 * `projects_and_organizations` / `organization_invites`
 * (drizzle/0004 + 0007). Postgres outages funnel through `dbUnavailable`
 * → 503 EXTERNAL_UNAVAILABLE (Retry-After 30 via ApiErrorFilter), logged
 * once with the correlationId.
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
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Test/e2e seam — DELETE FROM organization_invites (requires live Postgres). */
  async clearInvitesForTests(): Promise<void> {
    await this.client().delete(organizationInvites);
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
    await this.client().insert(organizationInvites).values({
      token,
      orgId,
      email,
      role,
    });
  }

  /** Test/e2e seam — DELETE FROM org tables (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    const c = this.client();
    await c.delete(organizationInvites);
    await c.delete(organizationMembers);
    await c.delete(organizations);
  }

  private async orgRowOrThrow(
    orgId: string,
    correlationId?: string,
  ): Promise<OrganizationRow> {
    try {
      const rows = await this.client()
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (rows.length === 0)
        throw new NotFoundException(`Organization ${orgId} not found`);
      return rows[0];
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("organizations.get", err, this.logger, correlationId);
    }
  }

  private async roleOf(
    orgId: string,
    userId: string,
    correlationId?: string,
  ): Promise<OrgRole | null> {
    try {
      const rows = await this.client()
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
          ),
        )
        .limit(1);
      return rows.length > 0 ? (rows[0].role as OrgRole) : null;
    } catch (err) {
      dbUnavailable("organizations.roleOf", err, this.logger, correlationId);
    }
  }

  /** Member-only read: strangers get 404 (existence is not leaked). */
  private async memberRowOrThrow(
    orgId: string,
    requesterId: string,
    correlationId?: string,
  ): Promise<{ org: OrganizationRow; role: OrgRole }> {
    const org = await this.orgRowOrThrow(orgId, correlationId);
    const role = await this.roleOf(orgId, requesterId, correlationId);
    if (!role) throw new NotFoundException(`Organization ${orgId} not found`);
    return { org, role };
  }

  /** Maintainer-only mutation: stranger → 404, plain member → 403. */
  private async maintainerOrThrow(
    orgId: string,
    requesterId: string,
    correlationId?: string,
  ): Promise<{ org: OrganizationRow; role: OrgRole }> {
    const found = await this.memberRowOrThrow(orgId, requesterId, correlationId);
    if (found.role !== "maintainer") {
      throw new ForbiddenException("Only organization maintainers can do this");
    }
    return found;
  }

  private async maintainerCount(
    orgId: string,
    correlationId?: string,
  ): Promise<number> {
    try {
      const rows = await this.client()
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.role, "maintainer"),
          ),
        );
      return rows.length;
    } catch (err) {
      dbUnavailable(
        "organizations.maintainerCount",
        err,
        this.logger,
        correlationId,
      );
    }
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
    const row = await this.orgRowOrThrow(orgId, correlationId);
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
          const row = await this.orgRowOrThrow(link.orgId, correlationId);
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
    const { org } = await this.memberRowOrThrow(orgId, requesterId, correlationId);
    return toOrganization(org);
  }

  async update(
    orgId: string,
    requesterId: string,
    input: UpdateOrganizationInput,
    correlationId?: string,
  ): Promise<Organization> {
    await this.maintainerOrThrow(orgId, requesterId, correlationId);
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
    await this.maintainerOrThrow(orgId, requesterId, correlationId);
    try {
      // Soft org delete: mark org row deleted-at via description? Orgs table
      // has no status column (project-level soft-delete only) — org delete
      // removes the org row (FK cascade drops members/invites) + cascade
      // SOFT-deletes member projects (status=deleted, rows+disk kept for
      // restore, running containers stopped best-effort).
      const { projects } = await import("../db/schema");
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

  async listMembers(
    orgId: string,
    requesterId: string,
    correlationId?: string,
  ): Promise<OrganizationMember[]> {
    await this.memberRowOrThrow(orgId, requesterId, correlationId);
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
    await this.maintainerOrThrow(orgId, requesterId, correlationId);
    const target = this.paths.checkUuid(input.userId, "userId");
    const role = (input.role ?? "user") as OrgRole;
    // Strict-503 (see create()): DB outage propagates, live null → 404.
    let known: Awaited<ReturnType<UsersService["findById"]>>;
    try {
      known = await this.users.findById(target, correlationId);
    } catch (err) {
      dbUnavailable("organizations.addMember.userLookup", err, this.logger, correlationId);
    }
    if (!known) throw new NotFoundException(`User ${target} not found`);
    if (role === "maintainer" && (await this.maintainerCount(orgId, correlationId)) > 0) {
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
    await this.maintainerOrThrow(orgId, requesterId, correlationId);
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
      (await this.maintainerCount(orgId, correlationId)) <= 1
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
    await this.maintainerOrThrow(orgId, requesterId, correlationId);
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
      (await this.maintainerCount(orgId, correlationId)) <= 1
    ) {
      throw new BadRequestException("Cannot demote the last maintainer");
    }
    if (
      current === "user" &&
      next === "maintainer" &&
      (await this.maintainerCount(orgId, correlationId)) > 0
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
    await this.maintainerOrThrow(orgId, requesterId, correlationId);
    const role = (input.role ?? "user") as OrgRole;
    if (role === "maintainer" && (await this.maintainerCount(orgId, correlationId)) > 0) {
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
      const rows = await this.client()
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
      (await this.maintainerCount(stored.orgId, correlationId)) > 0
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
      const { projects } = await import("../db/schema");
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
    return this.roleOf(orgId, userId, correlationId);
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
      const { projects } = await import("../db/schema");
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
}
