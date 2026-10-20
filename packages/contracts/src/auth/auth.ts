/**
 * Auth account contracts.
 *
 * Mirrors contracts/openapi.yaml components/schemas: AuthUser, AuthTokens,
 * AuthSession (field-for-field). Request input types live in auth.schema.ts
 * (inferred from the backend-verbatim zod schemas).
 * Previously duplicated in apps/backend/src/contracts.ts and
 * apps/frontend/src/api/types.ts — this package is the single source.
 */

/** POST /api/v1/auth/register + login response user (never carries passwordHash) */
export type AuthUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  provider: 'local' | 'sso-oauth' | 'github-app';
  /** ISO-8601 timestamp */
  createdAt: string;
};

/** Token pair (short-lived access + rotating refresh). */
export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  tokenType: 'bearer';
  /** Access lifetime in seconds. */
  expiresIn: number;
};

/** POST /api/v1/auth/register + login response (user + tokens). */
export type AuthSession = AuthTokens & {
  user: AuthUser;
};
