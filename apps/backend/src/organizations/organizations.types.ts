import { randomBytes } from "node:crypto";
import type {
  OrganizationInviteRow,
  OrganizationMemberRow,
  OrganizationRow,
} from "../common/db/schema";

/**
 * Shared types + pure codecs for the organization scope.
 *
 * Kept free of Nest providers so organizations.service, members/ and
 * invites/ all encode rows the same way (ISO-8601 `*At` over the wire,
 * never Date). `OrganizationsService` re-exports these for back-compat.
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

export function toOrganization(row: OrganizationRow): Organization {
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

export function toMember(row: OrganizationMemberRow): OrganizationMember {
  return {
    orgId: row.orgId,
    userId: row.userId,
    role: row.role as OrgRole,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toInvite(row: OrganizationInviteRow): OrganizationInvite {
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
export function pgCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur !== null && cur !== undefined; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isPgUniqueViolation(err: unknown): boolean {
  if (pgCode(err) === "23505") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /duplicate key|unique/i.test(msg);
}

export function isPgForeignKeyViolation(err: unknown): boolean {
  if (pgCode(err) === "23503") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /foreign key|violates foreign/i.test(msg);
}

/** uuid shape check (mirrors UsersService.isUserId — non-uuid keys never match a row). */
export function isUuidKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
