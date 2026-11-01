import type { OrganizationMemberRow } from "../../../common/db/schema";
import type { OrganizationMember, OrgRole } from "../../organizations.types";

/**
 * Row → wire codec for `organization_members` (pure, no I/O): timestamps
 * become ISO-8601 strings, the DB role string narrows to `OrgRole`.
 */
export function toMember(row: OrganizationMemberRow): OrganizationMember {
  return {
    orgId: row.orgId,
    userId: row.userId,
    role: row.role as OrgRole,
    createdAt: row.createdAt.toISOString(),
  };
}
