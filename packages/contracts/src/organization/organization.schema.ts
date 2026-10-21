import { z } from 'zod';

import type {
  Organization,
  OrganizationInvite,
  OrganizationMember,
  OrgRole,
} from './organization';

/**
 * Boundary schemas for organization.ts.
 * Input schemas are verbatim apps/backend/src/organizations/dto.ts (same
 * min/max, uuid shapes, defaults + error strings) so backend/frontend
 * validation stays identical after consumer migration. Response schemas
 * mirror contracts/openapi.yaml.
 */

export const orgRoleSchema = z.enum(['maintainer', 'user'], {
  error: 'role must be maintainer or user',
}) satisfies z.ZodType<OrgRole>;

/** uuid with distinct missing/invalid messages (backend dto parity). */
const requiredUuid = (requiredError: string, invalidError: string) =>
  z.uuid({
    error: (iss) => (iss.code === 'invalid_type' ? requiredError : invalidError),
  });

export const createOrganizationSchema = z.object({
  name: z.string({ error: 'Field "name" is required' }).min(1).max(200),
  description: z.string().max(2000).optional(),
  isPrivate: z.boolean().optional().default(true),
});

export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  isPrivate: z.boolean().optional(),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const addMemberSchema = z.object({
  userId: requiredUuid('Field "userId" is required', 'userId must be a uuid'),
  role: orgRoleSchema.optional().default('user'),
});

export type AddMemberInput = z.input<typeof addMemberSchema>;

export const updateMemberRoleSchema = z.object({
  role: orgRoleSchema,
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const createInviteSchema = z.object({
  role: orgRoleSchema.optional().default('user'),
  email: z
    .string()
    .trim()
    .min(1)
    .max(320)
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      error: 'must be a valid email',
    })
    .optional(),
});

export type CreateInviteInput = z.input<typeof createInviteSchema>;

export const acceptInviteSchema = z.object({
  token: z.uuidv7({ error: 'token must be a uuidv7 invite token' }),
});

export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  ownerId: z.uuid().nullable(),
  isPrivate: z.boolean(),
  /** ISO-8601 timestamp */
  createdAt: z.string().min(1),
  /** ISO-8601 timestamp */
  updatedAt: z.string().min(1),
}) satisfies z.ZodType<Organization>;

export const organizationMemberSchema = z.object({
  orgId: z.uuid(),
  userId: z.uuid(),
  role: orgRoleSchema,
  /** ISO-8601 timestamp */
  createdAt: z.string().min(1),
}) satisfies z.ZodType<OrganizationMember>;

export const organizationInviteSchema = z.object({
  token: z.uuidv7(),
  orgId: z.uuid(),
  email: z.string().max(320).nullable(),
  role: orgRoleSchema,
  /** ISO-8601 timestamp */
  createdAt: z.string().min(1),
}) satisfies z.ZodType<OrganizationInvite>;
