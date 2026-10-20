import { z } from 'zod';

import type {
  OpencodeKeyDeleteResult,
  OpencodeKeyResult,
  OpencodeKeyStatus,
  OpencodeLimitBucket,
  OpencodeUsage,
} from './opencode-key';

/**
 * Boundary schemas for opencode-key.ts.
 * opencodeKeySchema is verbatim apps/backend/src/opencode-keys/dto.ts
 * (same trim/min/max + error strings): short strings are almost certainly
 * a paste mistake, so min 20 fails fast. Response schemas mirror
 * contracts/openapi.yaml (OpencodeKeyResult/Status/Usage/LimitBucket).
 */

export const opencodeKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(20, { error: 'must be at least 20 characters' })
    .max(1024, { error: 'must be ≤ 1024 chars' }),
});

export type OpencodeKeyInput = z.infer<typeof opencodeKeySchema>;

export const opencodeKeyResultSchema = z.object({
  ok: z.boolean(),
  /** ISO-8601 timestamp */
  updatedAt: z.string().min(1),
}) satisfies z.ZodType<OpencodeKeyResult>;

export const opencodeKeyDeleteResultSchema = z.object({
  ok: z.boolean(),
}) satisfies z.ZodType<OpencodeKeyDeleteResult>;

export const opencodeKeyStatusSchema = z.object({
  configured: z.boolean(),
  /** ISO-8601 timestamp (present only when configured). */
  updatedAt: z.string().min(1).optional(),
}) satisfies z.ZodType<OpencodeKeyStatus>;

export const opencodeLimitBucketSchema = z.object({
  used: z.number(),
  limit: z.number(),
}) satisfies z.ZodType<OpencodeLimitBucket>;

export const opencodeUsageSchema = z.object({
  balance: z.number().optional(),
  usage: z.number().optional(),
  /** ISO-8601 time of the upstream response */
  updatedAt: z.string().min(1),
  rolling: opencodeLimitBucketSchema.optional(),
  daily: opencodeLimitBucketSchema.optional(),
  weekly: opencodeLimitBucketSchema.optional(),
  monthly: opencodeLimitBucketSchema.optional(),
}) satisfies z.ZodType<OpencodeUsage>;
