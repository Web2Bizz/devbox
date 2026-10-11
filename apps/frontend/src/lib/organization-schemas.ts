import { z } from 'zod';

/**
 * Organization-name validation — mirrors backend (name required) + UX trim.
 * Org names are free-form (any visible chars), only length-checked 2..100.
 */
export const createOrganizationSchema = z.object({
  name: z
    .string({ error: 'org_name_required' })
    .trim()
    .min(1, { error: 'org_name_required' })
    .min(2, { error: 'org_name_too_short' })
    .max(100, { error: 'org_name_too_long' }),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const ORG_NAME_MIN = 2;
export const ORG_NAME_MAX = 100;
