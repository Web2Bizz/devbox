import { z } from 'zod';

import type { AuthSession, AuthTokens, AuthUser } from './auth';

/**
 * Boundary schemas for auth.ts.
 * Input schemas are verbatim apps/backend/src/auth/dto.ts (same trims,
 * min/max, email regex + error strings) so backend/frontend validation
 * stays identical after consumer migration. The email regex is intentionally
 * copied — not z.email() — to preserve trim-first semantics and the exact
 * backend message on every input. Response schemas mirror
 * contracts/openapi.yaml (AuthUser/AuthTokens/AuthSession).
 */

const nameField = z
  .string()
  .trim()
  .min(1, { error: 'must not be empty' })
  .max(100, { error: 'must be ≤ 100 chars' });

const emailField = z
  .string()
  .trim()
  .min(1, { error: 'must not be empty' })
  .max(320, { error: 'must be ≤ 320 chars' })
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
    error: 'must be a valid email',
  });

const passwordField = z
  .string()
  .min(8, { error: 'must be at least 8 characters' })
  .max(256, { error: 'must be ≤ 256 chars' });

/** POST /api/v1/auth/register — firstName/lastName/email/password. */
export const registerSchema = z.object({
  firstName: nameField,
  lastName: nameField,
  email: emailField,
  password: passwordField,
});

export type RegisterInput = z.infer<typeof registerSchema>;

/** POST /api/v1/auth/login — email+password. */
export const loginSchema = z.object({
  email: emailField,
  password: passwordField,
});

export type LoginInput = z.infer<typeof loginSchema>;

/** POST /api/v1/auth/refresh — single-use refresh token rotation. */
export const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1, { error: 'must not be empty' }),
});

export type RefreshInput = z.infer<typeof refreshSchema>;

/** PATCH /api/v1/auth/me — profile update (firstName/lastName only). */
export const updateMeSchema = z
  .object({
    firstName: nameField.optional(),
    lastName: nameField.optional(),
  })
  .refine((v) => v.firstName !== undefined || v.lastName !== undefined, {
    error: 'at least one of firstName/lastName is required',
  });

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const authUserSchema = z.object({
  id: z.uuid(),
  firstName: nameField,
  lastName: nameField,
  email: emailField,
  provider: z.enum(['local', 'sso-oauth', 'github-app']),
  /** ISO-8601 timestamp */
  createdAt: z.string().min(1),
}) satisfies z.ZodType<AuthUser>;

export const authTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenType: z.literal('bearer'),
  /** Access lifetime in seconds. */
  expiresIn: z.number().int().min(0),
}) satisfies z.ZodType<AuthTokens>;

export const authSessionSchema = authTokensSchema.extend({
  user: authUserSchema,
}) satisfies z.ZodType<AuthSession>;
