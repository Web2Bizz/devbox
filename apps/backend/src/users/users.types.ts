import type { AuthUser, RegisterInput, UpdateMeInput } from "@rush-code/contracts";

/**
 * Users domain types. Wire shapes mirror @rush-code/contracts (single source:
 * `AuthUser`, `registerSchema`, `updateMeSchema`) — no duplication, no
 * `interface` (CoC §1); every timestamp is an ISO-8601 string (CoC §2).
 */

/** Auth provider ids — `local` is live; the rest are 501 stubs (no integration). */
export type AuthProviderId = AuthUser["provider"];

/**
 * Stored user (durable contract = `users` drizzle table, drizzle/0003_users.sql).
 * Public wire shape + the DB-only secret and mutation stamp.
 */
export type StoredUser = AuthUser & {
  /** argon2id hash — never logged, never serialized. */
  passwordHash: string;
  /** ISO-8601 timestamp */
  updatedAt: string;
};

/** Public shape — never carries passwordHash (never logged, never serialized). */
export type PublicUser = AuthUser;

/** Local registration input (contracts etalon: `registerSchema`). */
export type CreateLocalInput = RegisterInput;

/** Profile patch (contracts etalon: `updateMeSchema`). */
export type UpdateProfilePatch = UpdateMeInput;

/** Express request slice carrying the id set by the correlation middleware. */
export type RequestCorrelation = {
  correlationId?: string;
};
