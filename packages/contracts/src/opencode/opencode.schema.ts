import { z } from 'zod';

import type {
  OpencodeCommand,
  OpencodeFork,
  OpencodeHealth,
  OpencodePrompt,
  OpencodeSessionUpdate,
  OpencodeShell,
} from './opencode';

/**
 * Boundary schemas for opencode.ts.
 *
 * Verbatim apps/backend/src/api/dto.ts (same field constraints + error
 * strings) so backend/frontend validation stays identical after consumer
 * migration. Response shapes mirror contracts/openapi.yaml field-for-field
 * (OpencodePrompt/Command/Shell/Fork/SessionUpdate/Health).
 */

const opencodeModelSchema = z.object({
  providerID: z.string({ error: 'Field "model.providerID" is required' }).min(1),
  modelID: z.string({ error: 'Field "model.modelID" is required' }).min(1),
});

const opencodeTextPartSchema = z.object({
  type: z.literal('text', { error: 'Only "text", "file", "agent", "subtask" parts are accepted' }),
  text: z
    .string({ error: 'Field "parts[].text" is required' })
    .min(1, { error: 'Field "parts[].text" is required' }),
});

const opencodeFilePartSchema = z.object({
  type: z.literal('file'),
  mime: z.string({ error: 'Field "parts[].mime" is required' }).min(1),
  url: z.string({ error: 'Field "parts[].url" is required' }).min(1),
  filename: z.string().optional(),
});

const opencodeAgentPartSchema = z.object({
  type: z.literal('agent'),
  name: z.string({ error: 'Field "parts[].name" is required' }).min(1),
});

const opencodeSubtaskPartSchema = z.object({
  type: z.literal('subtask'),
  prompt: z.string({ error: 'Field "parts[].prompt" is required' }).min(1),
  description: z.string({ error: 'Field "parts[].description" is required' }).min(1),
  agent: z.string({ error: 'Field "parts[].agent" is required' }).min(1),
});

export const opencodePromptSchema = z.object({
  messageID: z.string().optional(),
  model: opencodeModelSchema.optional(),
  agent: z.string().optional(),
  noReply: z.boolean().optional(),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  variant: z.string().optional(),
  format: z.unknown().optional(),
  parts: z
    .array(
      z.union([
        opencodeTextPartSchema,
        opencodeFilePartSchema,
        opencodeAgentPartSchema,
        opencodeSubtaskPartSchema,
      ]),
    )
    .min(1, { error: 'Field "parts" must be a non-empty array' }),
}) satisfies z.ZodType<OpencodePrompt>;

export type OpencodePromptInput = z.infer<typeof opencodePromptSchema>;

export const opencodeCommandSchema = z.object({
  messageID: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  arguments: z
    .string({ error: 'Field "arguments" is required' })
    .min(1, { error: 'Field "arguments" is required' }),
  command: z
    .string({ error: 'Field "command" is required' })
    .min(1, { error: 'Field "command" is required' }),
  variant: z.string().optional(),
}) satisfies z.ZodType<OpencodeCommand>;

export type OpencodeCommandInput = z.infer<typeof opencodeCommandSchema>;

export const opencodeShellSchema = z.object({
  messageID: z.string().optional(),
  agent: z
    .string({ error: 'Field "agent" is required' })
    .min(1, { error: 'Field "agent" is required' }),
  model: opencodeModelSchema.optional(),
  command: z
    .string({ error: 'Field "command" is required' })
    .min(1, { error: 'Field "command" is required' }),
}) satisfies z.ZodType<OpencodeShell>;

export type OpencodeShellInput = z.infer<typeof opencodeShellSchema>;

export const opencodeForkSchema = z.object({
  messageID: z.string().optional(),
}) satisfies z.ZodType<OpencodeFork>;

export type OpencodeForkInput = z.infer<typeof opencodeForkSchema>;

export const opencodeSessionUpdateSchema = z.object({
  title: z.string().optional(),
}) satisfies z.ZodType<OpencodeSessionUpdate>;

export type OpencodeSessionUpdateInput = z.infer<typeof opencodeSessionUpdateSchema>;

export const opencodeHealthSchema = z.object({
  healthy: z.boolean(),
  version: z.string().min(1),
}) satisfies z.ZodType<OpencodeHealth>;
