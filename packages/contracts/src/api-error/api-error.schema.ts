import { z } from 'zod';

import type { ApiError } from './api-error';

/**
 * Boundary schema for api-error.ts.
 * Field set is frozen (code/message/correlationId only, mirroring
 * contracts/openapi.yaml ApiError); min(1) rejects empty envelopes at
 * the boundary without constraining the open code value set.
 */

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  correlationId: z.string().min(1),
}) satisfies z.ZodType<ApiError>;
