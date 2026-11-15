import { z } from 'zod';

import type { OpencodeLimitBucket, OpencodeUsage } from './opencode-key';

/**
 * Boundary schemas for opencode-key.ts (billing usage only).
 * Response schemas mirror contracts/openapi.yaml
 * (OpencodeUsage/OpencodeLimitBucket). Per-user API keys live in the vault
 * schemas (`vault.schema.ts`) — the legacy per-user key surface is gone.
 */

export const opencodeLimitBucketSchema = z.object({
  used: z.number(),
  limit: z.number(),
}) satisfies z.ZodType<OpencodeLimitBucket>;

export const opencodeUsageSchema = z.object({
  balance: z.number().optional(),
  usage: z.number().optional(),
  /** ISO-8601 time of the upstream response */
  updatedAt: z.iso.datetime({ error: 'Field "updatedAt" must be an ISO-8601 timestamp' }),
  rolling: opencodeLimitBucketSchema.optional(),
  daily: opencodeLimitBucketSchema.optional(),
  weekly: opencodeLimitBucketSchema.optional(),
  monthly: opencodeLimitBucketSchema.optional(),
}) satisfies z.ZodType<OpencodeUsage>;
