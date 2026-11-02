import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { readIdentity } from "../auth/identity.service";
import { AppLogger } from "../common/logger";
import { DbService, dbUnavailable, type DbClient } from "../common/db/db.service";
import {
  organizationMembers,
  organizations,
  type OrganizationRow,
} from "../common/db/schema";
import type { OrgRole } from "./organizations.types";

/**
 * OrganizationsGuard — the shared org access gate (defense in depth — the
 * services repeat it):
 * - reads (get/members) are member-only: strangers get 404 (the org's very
 *   existence is not leaked);
 * - mutations (settings/members/invites/links) are maintainer-only:
 *   non-member → 404, member without the role → 403;
 * - exactly one maintainer per org: the partial unique index
 *   (org_id WHERE role='maintainer') wins races; callers pre-check for
 *   friendly 409s and guard the last-maintainer removal/demotion with 400.
 *
 * Two surfaces on one class: the policy methods (orgRowOrThrow, roleOf,
 * memberRowOrThrow, maintainerOrThrow, maintainerCount, getRole) are called
 * by the domain services, while `canActivate` applies the same policy as an
 * HTTP guard on the routes that carry `:id` (defense in depth — the services
 * keep their own checks). Because a guard runs before pipes, malformed
 * bodies on gated routes are answered 404/403 before validation ever sees
 * them.
 *
 * Every lookup funnels Postgres outages through `dbUnavailable` → 503
 * EXTERNAL_UNAVAILABLE (Retry-After 30 via ApiErrorFilter), logged once with
 * the correlationId. Logs carry only ids/reasons.
 */
@Injectable()
export class OrganizationsGuard implements CanActivate {
  constructor(
    private readonly logger: AppLogger = new AppLogger(OrganizationsGuard.name),
    private readonly db: DbService,
  ) {}

  /**
   * HTTP guard: GET on an org-scoped route needs membership, every other
   * method needs the maintainer role. Routes without a `:id` param (create,
   * list, invite accept) are not gated here. An anonymous request is
   * fail-closed 401 `unauthorized` — no pass-through, no DB lookups.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      params?: { id?: string };
      method?: string;
      correlationId?: string;
    }>();
    const orgId = req.params?.id;
    if (!orgId) return true;
    const identity = readIdentity(req);
    if (!identity) {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
    if (req.method === "GET") {
      await this.memberRowOrThrow(orgId, identity.id, req.correlationId);
      return true;
    }
    await this.maintainerOrThrow(orgId, identity.id, req.correlationId);
    return true;
  }

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Org row or 404 — shared by the org CRUD and every gate below. */
  async orgRowOrThrow(
    orgId: string,
    correlationId?: string,
  ): Promise<OrganizationRow> {
    try {
      const rows = await this.client()
        .select()
        .from(organizations)
        .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
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
      // Join the org row: a member row alone must not authorize an org that
      // was soft-deleted (its projects are cascaded at removal, but a direct
      // getRole/repos lookup must fail closed too).
      const rows = await this.client()
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          eq(organizationMembers.orgId, organizations.id),
        )
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
            isNull(organizations.deletedAt),
          ),
        )
        .limit(1);
      return rows.length > 0 ? (rows[0].role as OrgRole) : null;
    } catch (err) {
      dbUnavailable("organizations.roleOf", err, this.logger, correlationId);
    }
  }

  /** Member-only read: strangers get 404 (existence is not leaked). */
  async memberRowOrThrow(
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
  async maintainerOrThrow(
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

  async maintainerCount(
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

  /** Null for strangers (access-layer helper — callers map null → 404). */
  async getRole(
    orgId: string,
    userId: string,
    correlationId?: string,
  ): Promise<OrgRole | null> {
    return this.roleOf(orgId, userId, correlationId);
  }
}
