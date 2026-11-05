import type { ToolView } from '@rush-code/contracts';

export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ModelUsage = { in: number; out: number };

export type ModelEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'done'; usage: ModelUsage };

export type ModelRequest = {
  model: string;
  system?: string;
  messages: Array<ModelMessage>;
  /** Only the ToolView projection ever reaches the model (D3). */
  tools?: Array<ToolView>;
  responseFormat?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  need: { toolCalls?: boolean; jsonSchema?: boolean; vision?: boolean; reasoning?: boolean };
};

/**
 * ModelGateway — the single model-port of the run engine.
 *
 * Provider-specific transports stay behind this boundary; the claim loop only
 * sees the normalized ModelEvent stream (deltas, tool calls, a terminal done
 * with usage). Tools travel as the ToolView projection only (D3), never as
 * handlers or policy.
 */
export abstract class ModelGateway {
  abstract stream(req: ModelRequest): AsyncIterable<ModelEvent>;
}
