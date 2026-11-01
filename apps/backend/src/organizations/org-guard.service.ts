import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { AppLogger } from "../common/logger";
import { DbService, dbUnavailable, type DbClient } from "../common/db/db.service";
import {
  organizationMembers,
  organizations,
  type OrganizationRow,
} from "../common/db/schema";
import type { OrgRole } from "./organizations.types";

/**
 * OrgGuardService — the shared org access gate (defense in depth — HTTP
 * guards repeat it):
 * - reads (get/members) are member-only: strangers get 404 (the org's very
 *   existence is not leaked);
 * - mutations (settings/members/invites/links) are maintainer-only:
 *   non-member → 404, member without the role → 403;
 * - exactly one maintainer per org: the partial unique index
 *   (org_id WHERE role='maintainer') wins races; callers pre-check for
 *   friendly 409s and guard the last-maintainer removal/demotion with 400.
 *
 * Every lookup funnels Postgres outages through `dbUnavailable` → 503
 * EXTERNAL_UNAVAILABLE (Retry-After 30 via ApiErrorFilter), logged once with
 * the correlationId. Logs carry only ids/reasons.
 */
@Injectable()
export class OrgGuardService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("OrgGuardService"),
    private readonly db: DbService,
  ) {}

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
