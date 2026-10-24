import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * POST /api/v1/chat body — single source of truth is @rush-code/contracts
 * (verbatim constraints + error strings, Standard Schema compatible).
 * SendChatRequestDto below stays as the thin @nestjs/swagger wrapper for
 * contracts/openapi.yaml parity. Runtime validation via
 * ZodValidationPipe(sendChatSchema).
 */
export { sendChatSchema, type SendChatInput } from '@rush-code/contracts';

/**
 * POST /api/opencode/session/:id/message body — passthrough shape for the
 * sdk `session.prompt()` call (upstream opencode OpenAPI `session.prompt`,
 * see contracts/opencode-upstream.json). Full upstream body: optional
 * messageID/model/agent/noReply/system/tools/variant/format + required
 * non-empty parts (text/file/agent/subtask). Text-only callers keep working:
 * `{ parts: [{ type: 'text', text: 'hi' }] }` still validates.
 */
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

const opencodeModelSchema = z.object({
  providerID: z.string({ error: 'Field "model.providerID" is required' }).min(1),
  modelID: z.string({ error: 'Field "model.modelID" is required' }).min(1),
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
});

export type OpencodePromptInput = z.infer<typeof opencodePromptSchema>;

/**
 * POST /api/opencode/session/:id/command body — upstream `session.command`
 * (required: command + arguments; model is a plain string here, unlike
 * prompt's {providerID, modelID} object).
 */
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
});

export type OpencodeCommandInput = z.infer<typeof opencodeCommandSchema>;

/**
 * POST /api/opencode/session/:id/shell body — upstream `session.shell`
 * (required: agent + command).
 */
export const opencodeShellSchema = z.object({
  messageID: z.string().optional(),
  agent: z
    .string({ error: 'Field "agent" is required' })
    .min(1, { error: 'Field "agent" is required' }),
  model: opencodeModelSchema.optional(),
  command: z
    .string({ error: 'Field "command" is required' })
    .min(1, { error: 'Field "command" is required' }),
});

export type OpencodeShellInput = z.infer<typeof opencodeShellSchema>;

/**
 * POST /api/opencode/session/:id/fork body — upstream `session.fork`
 * (optional messageID to fork at a specific message).
 */
export const opencodeForkSchema = z.object({
  messageID: z.string().optional(),
});

export type OpencodeForkInput = z.infer<typeof opencodeForkSchema>;

/**
 * PATCH /api/opencode/session/:id body — upstream `session.update`
 * (all-optional; title is the primary field).
 */
export const opencodeSessionUpdateSchema = z.object({
  title: z.string().optional(),
});

export type OpencodeSessionUpdateInput = z.infer<typeof opencodeSessionUpdateSchema>;

export class SendChatRequestDto {
  @ApiProperty({ required: false, example: 'ses_abc123' })
  sessionId?: string;

  @ApiProperty({ example: 'hello' })
  message!: string;
}

export class ChatMessageDto {
  @ApiProperty({ example: 'msg_abc123' })
  id!: string;

  @ApiProperty({ example: 'ses_abc123' })
  sessionId!: string;

  @ApiProperty({ enum: ['user', 'assistant', 'system'], example: 'assistant' })
  role!: string;

  @ApiProperty({ example: 'Hello from the live opencode server' })
  content!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class SessionDto {
  @ApiProperty({ example: 'ses_abc123' })
  id!: string;

  @ApiProperty({ example: 'My session' })
  title!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ required: false, example: 'default' })
  model?: string;
}

export class SendChatResponseDto {
  @ApiProperty({ example: 'ses_abc123' })
  sessionId!: string;

  @ApiProperty({ type: () => ChatMessageDto })
  message!: ChatMessageDto;
}

export class MessagesResponseDto {
  @ApiProperty({ example: 'ses_abc123' })
  sessionId!: string;

  @ApiProperty({ type: () => [ChatMessageDto] })
  messages!: ChatMessageDto[];
}

export class HealthDto {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ enum: ['up', 'down', 'skipped'], example: 'skipped' })
  db!: string;

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  opencode!: string;

  @ApiProperty({ enum: ['up', 'down', 'skipped'], example: 'skipped' })
  registry!: string;

  @ApiProperty({ enum: ['up', 'down', 'skipped'], example: 'skipped' })
  npmRegistry!: string;
}

export class ApiErrorDto {
  @ApiProperty({ example: 'bad_request' })
  code!: string;

  @ApiProperty({ example: 'Field "message" is required' })
  message!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  correlationId!: string;
}
