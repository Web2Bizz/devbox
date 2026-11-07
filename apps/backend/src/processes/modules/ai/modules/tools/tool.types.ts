/**
 * Tool contracts of the AI tool layer (ai/modules/tools).
 *
 * Pure shapes only: a handler answers the registry name (`name` or
 * `namespace.name`), the prompt-facing definition and one `execute` call.
 * Dispatch settles every call as a string result — unknown tool, malformed
 * JSON and jail escapes are error-results, never exceptions (the model gets
 * the text back and may retry).
 */

/** Execution context of one call (the gated project directory + session). */
export type ToolContext = {
  /** Absolute project content directory (already passed the C4 gate). */
  directory: string;
  /** Domain session id — used by stateful tools (todo list). */
  sessionId?: string;
};

/** Prompt-facing tool definition (name/namespace/description/input hint). */
export type ToolDefinition = {
  name: string;
  namespace?: string;
  description: string;
  /** JSON-schema-ish description of the accepted input (documentation only). */
  inputSchema: Record<string, unknown>;
};

/** One registered tool. `fullName` is `namespace.name` when namespaced. */
export type ToolHandler = {
  fullName: string;
  definition: ToolDefinition;
  execute(input: unknown, context: ToolContext): Promise<string>;
};

/**
 * One model-requested call. `arguments` stays the raw JSON text the model
 * produced: parsing happens in dispatch so invalid JSON becomes a retryable
 * error-result instead of a thrown stack.
 */
export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

/** Settled call — `callID`/`name` mirror the request, `result` is model text. */
export type ToolSettlement = {
  callID: string;
  name: string;
  result: string;
};

/** Console/report label of a tool call (pure mapping, no lookups). */
export function toolLabel(name: string): string {
  return name;
}
