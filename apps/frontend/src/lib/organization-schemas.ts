import { z } from 'zod';

/**
 * Organization-name validation — UX-strict superset of the wire contract.
 *
 * Wire source of truth is `@devbox/contracts` (`createOrganizationSchema`:
 * backend-verbatim 1..200, no trim). This local schema stays intentionally
 * STRICTER (trim + 2..100 + i18n codes `org_name_*` mapped in
 * CreateOrganizationDialog) — replacing it with the package schema would
 * LOOSEN form validation and break the dialog error mapping. Wire shape is
 * frozen, so the local form schema must remain a subset of what the wire
 * accepts.
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
