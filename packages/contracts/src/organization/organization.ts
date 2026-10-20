/**
 * Organization contracts.
 *
 * Mirrors contracts/openapi.yaml components/schemas: Organization,
 * OrganizationMember, OrganizationInvite, OrgRole (+ CreateOrganization,
 * UpdateOrganization, AddMember, UpdateMemberRole, CreateInvite,
 * AcceptInvite inputs). Request input types live in organization.schema.ts
 * (inferred from the backend-verbatim zod schemas). All contracts here were
 * introduced additively — no existing schema is modified.
 */

export type OrgRole = 'maintainer' | 'user';

export type Organization = {
  id: string;
  name: string;
  description: string | null;
  /** creator (SET NULL — the org outlives its creator) */
  ownerId: string | null;
  isPrivate: boolean;
  /** ISO-8601 timestamp */
  createdAt: string;
  /** ISO-8601 timestamp */
  updatedAt: string;
};

export type OrganizationMember = {
  orgId: string;
  userId: string;
  role: OrgRole;
  /** ISO-8601 timestamp */
  createdAt: string;
};

/** Single-use bearer token — returned ONCE, never logged, TTL ORG_INVITE_TTL_SEC. */
export type OrganizationInvite = {
  token: string;
  orgId: string;
  role: OrgRole;
  /** ISO-8601 timestamp */
  expiresAt: string;
};
