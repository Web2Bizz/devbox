/**
 * Organizations domain wire types (response shapes, never persisted as-is).
 * Shared by the org CRUD service, the membership/invites services and their
 * pure codecs in `utils/organization-member`.
 */

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
