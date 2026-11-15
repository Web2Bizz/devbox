import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { readIdentity, type RequestIdentity } from "../auth/identity.service";
import { AppLogger } from "@common/logger";
import { DbService, dbUnavailable, type DbClient, type DbReadOptions } from "@common/db/db.service";
import {
  organizationMembers,
  organizations,
  type OrganizationMemberRow,
  type OrganizationRow,
} from "@common/db/schema";
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
    const request: {
      params?: { id?: string };
      method?: string;
      correlationId?: string;
    } = context.switchToHttp().getRequest<{
      params?: { id?: string };
      method?: string;
      correlationId?: string;
    }>();
    const orgId: string | undefined = request.params?.id;
    if (!orgId) return true;
    const identity: RequestIdentity | null = readIdentity(request);
    if (!identity) {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
    if (request.method === "GET") {
      await this.memberRowOrThrow(orgId, identity.id, request.correlationId);
      return true;
    }
    await this.maintainerOrThrow(orgId, identity.id, request.correlationId);
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
    readOptions: DbReadOptions = {},
  ): Promise<OrganizationRow> {
    try {
      // Idempotent SELECT — resilient path (breaker + 5-attempt retry on
      // pg ECONNRESET/ETIMEDOUT/EPIPE); outage → raw throw, funneled below
      // to 503 EXTERNAL_UNAVAILABLE (Retry-After 30, contract unchanged).
      const rows: Array<OrganizationRow> = await this.db.executeRead(
        "organizations.get",
        () =>
          this.client()
            .select()
            .from(organizations)
            .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
            .limit(1),
        { ...readOptions, correlationId: correlationId ?? readOptions.correlationId },
      );
      if (rows.length === 0)
        throw new NotFoundException(`Organization ${orgId} not found`);
      return rows[0];
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      dbUnavailable("organizations.get", error, this.logger, correlationId);
    }
  }

  private async roleOf(
    orgId: string,
    userId: string,
    correlationId?: string,
    readOptions: DbReadOptions = {},
  ): Promise<OrgRole | null> {
    try {
      // Join the org row: a member row alone must not authorize an org that
      // was soft-deleted (its projects are cascaded at removal, but a direct
      // getRole/repos lookup must fail closed too). Idempotent SELECT — same
      // resilient path as orgRowOrThrow.
      const rows: Array<{ role: string }> = await this.db.executeRead(
        "organizations.roleOf",
        () =>
          this.client()
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
            .limit(1),
        { ...readOptions, correlationId: correlationId ?? readOptions.correlationId },
      );
      return rows.length > 0 ? (rows[0].role as OrgRole) : null;
    } catch (error) {
      dbUnavailable("organizations.roleOf", error, this.logger, correlationId);
    }
  }

  /** Member-only read: strangers get 404 (existence is not leaked). */
  async memberRowOrThrow(
    orgId: string,
    requesterId: string,
    correlationId?: string,
    readOptions: DbReadOptions = {},
  ): Promise<{ org: OrganizationRow; role: OrgRole }> {
    const org: OrganizationRow = await this.orgRowOrThrow(orgId, correlationId, readOptions);
    const role: OrgRole | null = await this.roleOf(orgId, requesterId, correlationId, readOptions);
    if (!role) throw new NotFoundException(`Organization ${orgId} not found`);
    return { org, role };
  }

  /** Maintainer-only mutation: stranger → 404, plain member → 403. */
  async maintainerOrThrow(
    orgId: string,
    requesterId: string,
    correlationId?: string,
    readOptions: DbReadOptions = {},
  ): Promise<{ org: OrganizationRow; role: OrgRole }> {
    const found: { org: OrganizationRow; role: OrgRole } = await this.memberRowOrThrow(
      orgId,
      requesterId,
      correlationId,
      readOptions,
    );
    if (found.role !== "maintainer") {
      throw new ForbiddenException("Only organization maintainers can do this");
    }
    return found;
  }

  async maintainerCount(
    orgId: string,
    correlationId?: string,
    readOptions: DbReadOptions = {},
  ): Promise<number> {
    try {
      // Idempotent SELECT — same resilient path as orgRowOrThrow.
      const rows: Array<OrganizationMemberRow> = await this.db.executeRead(
        "organizations.maintainerCount",
        () =>
          this.client()
            .select()
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.role, "maintainer"),
              ),
            ),
        { ...readOptions, correlationId: correlationId ?? readOptions.correlationId },
      );
      return rows.length;
    } catch (error) {
      dbUnavailable(
        "organizations.maintainerCount",
        error,
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
    readOptions: DbReadOptions = {},
  ): Promise<OrgRole | null> {
    return this.roleOf(orgId, userId, correlationId, readOptions);
  }
}
