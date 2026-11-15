import { z } from 'zod';

import type {
  VaultSecretDeleteResult,
  VaultSecretInfo,
  VaultSecretInput,
  VaultSecretList,
  VaultSecretUpdateInput,
} from './vault';

/**
 * Boundary schemas for vault.ts.
 *
 * The provider id is arbitrary (not only AI providers): lowercase, dot/dash/
 * underscore allowed after the first `[a-z0-9]`. The API key is write-only —
 * short strings are almost certainly a paste mistake, so min 20 fails fast.
 * Response schemas mirror the future contracts/openapi.yaml components.
 */

export const vaultProviderSchema: z.ZodString = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const vaultSecretInputSchema = z.object({
  provider: vaultProviderSchema,
  apiKey: z.string().trim().min(20).max(1024),
  label: z.string().trim().max(64).optional(),
}) satisfies z.ZodType<VaultSecretInput>;

export const vaultSecretUpdateSchema = z
  .object({
    apiKey: z.string().trim().min(20).max(1024).optional(),
    label: z.string().trim().max(64).optional(),
  })
  .refine(
    (value) => value.apiKey !== undefined || value.label !== undefined,
    { error: 'At least one of apiKey or label is required' },
  ) satisfies z.ZodType<VaultSecretUpdateInput>;

export const vaultSecretInfoSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  /** ISO-8601 timestamp */
  createdAt: z.iso.datetime({
    error: 'Field "createdAt" must be an ISO-8601 timestamp',
  }),
  /** ISO-8601 timestamp */
  updatedAt: z.iso.datetime({
    error: 'Field "updatedAt" must be an ISO-8601 timestamp',
  }),
}) satisfies z.ZodType<VaultSecretInfo>;

export const vaultSecretListSchema = z.object({
  secrets: z.array(vaultSecretInfoSchema),
}) satisfies z.ZodType<VaultSecretList>;

export const vaultSecretDeleteResultSchema = z.object({
  ok: z.boolean(),
}) satisfies z.ZodType<VaultSecretDeleteResult>;
