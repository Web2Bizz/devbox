import { z } from 'zod';

/**
 * Client-side auth validation (mirrors backend register/login rules so
 * typos are caught before the request; server 400/409 mapping in
 * register-field-errors stays as the fallback for backend rejections).
 *
 * Call sites pass already-trimmed email (the page trims on submit and the
 * hook trims defensively); firstName/lastName trim inside the schema so
 * whitespace-only names fail `min(1)`.
 */
export const loginSchema = z.object({
  email: z.email({ error: 'invalid_email' }),
  password: z.string({ error: 'required' }).min(8, { error: 'password_min' }),
});

export const registerSchema = loginSchema.extend({
  firstName: z
    .string({ error: 'required' })
    .trim()
    .min(1, { error: 'name_required' })
    .max(100, { error: 'name_too_long' }),
  lastName: z
    .string({ error: 'required' })
    .trim()
    .min(1, { error: 'name_required' })
    .max(100, { error: 'name_too_long' }),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
