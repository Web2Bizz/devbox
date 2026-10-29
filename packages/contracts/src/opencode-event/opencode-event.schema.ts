import { z } from 'zod';

import type {
  OpencodeBusEvent,
  OpencodeEvent,
  OpencodeEventDurable,
  OpencodeGlobalEvent,
} from './opencode-event';
import { opencodeLocationRefSchema } from '../opencode-session/opencode-session.schema';

/**
 * Boundary schemas for opencode-event.ts — SSE frame envelopes of the
 * /api/opencode/event + /api/opencode/global/event re-streams.
 *
 * Envelope-only by design (see opencode-event.ts): the upstream variant
 * union is large and upstream-owned; `data`/`properties` pass through as
 * unknown records. Unknown envelope keys are stripped, never rejected —
 * a forward-compatible server field must not break a client parse.
 */

export const opencodeEventDurableSchema = z.object({
  aggregateID: z.string({ error: 'Field "durable.aggregateID" is required' }).min(1),
  seq: z.number({ error: 'Field "durable.seq" is required' }),
  version: z.number({ error: 'Field "durable.version" is required' }),
}) satisfies z.ZodType<OpencodeEventDurable>;

export const opencodeEventSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  type: z.string({ error: 'Field "type" is required' }).min(1),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
  durable: opencodeEventDurableSchema.optional(),
  location: opencodeLocationRefSchema.optional(),
}) satisfies z.ZodType<OpencodeEvent>;

export const opencodeBusEventSchema = z.object({
  id: z.string({ error: 'Field "payload.id" is required' }).min(1),
  type: z.string({ error: 'Field "payload.type" is required' }).min(1),
  properties: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<OpencodeBusEvent>;

export const opencodeGlobalEventSchema = z.object({
  directory: z.string({ error: 'Field "directory" is required' }).min(1),
  project: z.string().optional(),
  workspace: z.string().optional(),
  payload: opencodeBusEventSchema,
}) satisfies z.ZodType<OpencodeGlobalEvent>;
