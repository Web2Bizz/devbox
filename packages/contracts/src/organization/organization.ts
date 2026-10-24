/**
 * Organization contracts.
 *
 * Mirrors contracts/openapi.yaml components/schemas: Organization,
 * OrganizationMember, OrganizationInvite, OrgRole (+ CreateOrganization,
 * UpdateOrganization, AddMember, UpdateMemberRole, CreateInvite,
 * AcceptInvite inputs). Request input types live in organization.schema.ts
 * (inferred from the backend-verbatim zod schemas).
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

/**
 * Single-use invite — uuidv7 token, no TTL (links never expire).
 * Returned ONCE, never logged. `email` is null for open link-invites,
 * or the bound address for email-invites (only that user can accept).
 */
export type OrganizationInvite = {
  /** uuidv7 invite token (link material, single-use) */
  token: string;
  orgId: string;
  /** bound email (lowercased) or null for open link-invites */
  email: string | null;
  role: OrgRole;
  /** ISO-8601 timestamp */
  createdAt: string;
};
