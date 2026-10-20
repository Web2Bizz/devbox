import { z } from 'zod';

import type {
  HealthResponse,
  NpmRegistryStatusResponse,
  RegistryCatalogResponse,
} from './health';

/**
 * Boundary schemas for health.ts.
 * Enums mirror contracts/openapi.yaml exactly (Health, RegistryCatalog,
 * NpmRegistryStatus). Scalar strings carry min(1): wire values are never
 * empty, so empty strings fail fast at the boundary.
 */

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  db: z.enum(['up', 'down', 'skipped']),
  opencode: z.enum(['up', 'down']),
  registry: z.enum(['up', 'down', 'skipped']),
  npmRegistry: z.enum(['up', 'down', 'skipped']),
}) satisfies z.ZodType<HealthResponse>;

export const registryCatalogResponseSchema = z.object({
  repositories: z.array(z.string().min(1)),
}) satisfies z.ZodType<RegistryCatalogResponse>;

export const npmRegistryStatusResponseSchema = z.object({
  status: z.literal('up'),
  url: z.string().min(1),
  scope: z.string().min(1),
}) satisfies z.ZodType<NpmRegistryStatusResponse>;
