import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
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
  organizationMembers,
  organizations,
  projectsAndOrganizations,
  type OrganizationMemberRow,
  type OrganizationRow,
} from "../db/schema";
import { validateEnv } from "../env";
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
  token: string;
  orgId: string;
  role: OrgRole;
  expiresAt: string;
};

type StoredInvite = {
  orgId: string;
  role: OrgRole;
  expiresAt: number;
  used: boolean;
};

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
 * `projects_and_organizations` (drizzle/0004_organizations.sql). Postgres
 * outages funnel through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30 via ApiErrorFilter), logged once with the correlationId.
 *
 * Access policy (defense in depth — HTTP guards in Card 6 repeat it):
 * - reads (get/members) are member-only: strangers get 404 (the org's
 *   very existence is not leaked);
 * - mutations (settings/members/invites/links) are maintainer-only:
 *   non-member → 404, member without the role → 403;
 * - exactly one maintainer per org: the partial unique index
 *   (org_id WHERE role='maintainer') wins races; the service pre-checks
 *   for friendly 409s and guards the last-maintainer removal/demotion
 *   with 400.
 *
 * Invites are single-use bearer tokens with the server-wide TTL from
 * ORG_INVITE_TTL_SEC (default 24h). MVP store is in-memory (single
 * instance); a consumed or expired token never grants membership twice.
 * Logs carry only ids/reasons — never tokens, emails, or secrets.
 */
@Injectable()
export class OrganizationsService {
  private readonly invites = new Map<string, StoredInvite>();

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

  private inviteTtlSec(): number {
    try {
      return validateEnv(process.env).orgInviteTtlSec;
    } catch {
      // validateEnv fails only on broken unrelated config (tests set a bare
      // env) — fall back to the documented 24h default, never throw here.
      return 86400;
    }
  }

  /** Test/e2e seam — drops all pending invite tokens. */
  clearInvitesForTests(): void {
    this.invites.clear();
  }

  /**
   * Test/e2e seam — plants a single-use invite with caller-controlled
   * expiry (TTL math under test control: seed `expiresAtMs` in the past
   * for the 410 path without waiting out ORG_INVITE_TTL_SEC).
   */
  seedInviteForTests(
    token: string,
    orgId: string,
    role: OrgRole,
    expiresAtMs: number,
  ): void {
    this.invites.set(token, { orgId, role, expiresAt: expiresAtMs, used: false });
  }

  /** Test/e2e seam — DELETE FROM org tables (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    const c = this.client();
    await c.delete(projectsAndOrganizations);
    await c.delete(organizationMembers);
    await c.delete(organizations);
    this.invites.clear();
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
      // FK cascade drops members + project links; projects themselves survive.
      await this.client().delete(organizations).where(eq(organizations.id, orgId));
      this.logger.info(`[organizations] removed org=${orgId}`, correlationId);
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
   * Mint a single-use invite (maintainer-only). The token is returned ONCE
   * (never logged, never stored in plain rows) and dies on first accept or
   * after ORG_INVITE_TTL_SEC seconds.
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
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.inviteTtlSec() * 1000;
    this.invites.set(token, { orgId, role, expiresAt, used: false });
    this.logger.info(`[organizations] invite created org=${orgId} role=${role}`, correlationId);
    return {
      token,
      orgId,
      role,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Accept a single-use invite. Missing/consumed → 404, expired → 410.
   * The token is marked used BEFORE the membership insert, so a raced or
   * failed accept can never grant membership twice.
   */
  async acceptInvite(
    input: AcceptInviteInput,
    userId: string,
    correlationId?: string,
  ): Promise<OrganizationMember> {
    const me = this.paths.checkUuid(userId, "userId");
    const stored = this.invites.get(input.token);
    if (!stored || stored.used) {
      throw new NotFoundException("Invite not found or already used");
    }
    if (Date.now() > stored.expiresAt) {
      this.invites.delete(input.token);
      throw new GoneException("Invite has expired");
    }
    stored.used = true;
    this.invites.set(input.token, stored);
    // Strict-503 (see create()): DB outage propagates, live null → 404.
    let known: Awaited<ReturnType<UsersService["findById"]>>;
    try {
      known = await this.users.findById(me, correlationId);
    } catch (err) {
      dbUnavailable("organizations.acceptInvite.userLookup", err, this.logger, correlationId);
    }
    if (!known) throw new NotFoundException(`User ${me} not found`);
    if (
      stored.role === "maintainer" &&
      (await this.maintainerCount(stored.orgId, correlationId)) > 0
    ) {
      throw new ConflictException("Organization already has a maintainer");
    }
    try {
      const rows = await this.client()
        .insert(organizationMembers)
        .values({ orgId: stored.orgId, userId: me, role: stored.role })
        .returning();
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
   * Attach a project to the org (metadata-only join row; disk homes are
   * NOT moved — see the manual-migration doc). Maintainer-only.
   */
  async linkProject(
    orgId: string,
    requesterId: string,
    projectId: string,
    correlationId?: string,
  ): Promise<void> {
    await this.maintainerOrThrow(orgId, requesterId, correlationId);
    const pid = this.paths.checkUuid(projectId, "projectId");
    try {
      await this.client()
        .insert(projectsAndOrganizations)
        .values({ orgId, projectId: pid });
      this.logger.info(`[organizations] project linked org=${orgId}`, correlationId);
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new ConflictException("Project is already linked to this organization");
      }
      if (isPgForeignKeyViolation(err)) {
        throw new NotFoundException(`Project ${pid} not found`);
      }
      dbUnavailable("organizations.linkProject", err, this.logger, correlationId);
    }
  }

  async unlinkProject(
    orgId: string,
    requesterId: string,
    projectId: string,
    correlationId?: string,
  ): Promise<void> {
    await this.maintainerOrThrow(orgId, requesterId, correlationId);
    const pid = this.paths.checkUuid(projectId, "projectId");
    try {
      const rows = await this.client()
        .select()
        .from(projectsAndOrganizations)
        .where(
          and(
            eq(projectsAndOrganizations.orgId, orgId),
            eq(projectsAndOrganizations.projectId, pid),
          ),
        )
        .limit(1);
      if (rows.length === 0)
        throw new NotFoundException(`Project ${pid} is not linked to this organization`);
      await this.client()
        .delete(projectsAndOrganizations)
        .where(
          and(
            eq(projectsAndOrganizations.orgId, orgId),
            eq(projectsAndOrganizations.projectId, pid),
          ),
        );
      this.logger.info(`[organizations] project unlinked org=${orgId}`, correlationId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("organizations.unlinkProject", err, this.logger, correlationId);
    }
  }

  /** Org ids a project is attached to (access-layer helper, no auth). */
  async orgIdsForProject(
    projectId: string,
    correlationId?: string,
  ): Promise<string[]> {
    try {
      const rows = await this.client()
        .select()
        .from(projectsAndOrganizations)
        .where(eq(projectsAndOrganizations.projectId, projectId));
      return rows.map((r) => r.orgId);
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
   * Project access gate (Card 5) — shared by sessions/chats/project-files.
   *
   * - Org-linked project (≥1 row in projects_and_organizations): access to
   *   any member of any linked org (`getRole` non-null). The owner fallback
   *   (ownerId === userId) also passes — the creator is a maintainer in
   *   practice, so this never widens the member rule.
   * - User-space project (no links): owner-only
   *   (ownerId === userId). Legacy ownerless rows (ownerId NULL, pre-auth)
   *   stay shared dev data and pass for anyone (projects.e2e + storage
   *   deny specs rely on it; new rows always carry a real owner).
   * - Strangers get 404 (the project's very existence is not leaked — the
   *   same no-enumeration rule as org reads). Non-uuid requesters (legacy
   *   mock `default`) skip the membership lookup (a non-uuid key can never
   *   match a uuid column — querying would 503 on 22P02) and only pass via
   *   the owner-equality/ownerless fallbacks above.
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
    if (ownerId === null || ownerId === undefined) return;
    if (ownerId.toLowerCase() === userId.toLowerCase()) return;
    throw new NotFoundException(`Project ${projectId} not found`);
  }
}
