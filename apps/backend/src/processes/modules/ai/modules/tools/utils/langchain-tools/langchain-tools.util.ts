/**
 * LangChain tool bindings — pure helpers over `ToolView` (no DI, no logger
 * ownership).
 *
 * A binding wraps exactly one `ToolView`; its `func` settles through the worker
 * registry, the MCP client or `ToolDispatchService`. Calling
 * `ToolDispatchService.dispatch` directly from an agent (outside a LangChain
 * tool) is forbidden: the LangChain tool call is the single executable path and
 * its call id is the traceability anchor for every effect.
 */
import { DynamicStructuredTool, type ToolRunnableConfig } from '@langchain/core/tools';
import type { ToolView } from '@rush-code/contracts';
import { z } from 'zod';
import type { ToolDispatchService } from '../../../tool-dispatch/tool-dispatch.service';
import type { ToolContext, ToolCall, ToolMode, ToolSettlement } from '../../../tool-runtime/tool-runtime.types';

/** One `ToolView` bound to its executable LangChain tool. */
export type LangChainToolBinding = {
  /** Model-facing projection the binding was built from. */
  view: ToolView;
  /** OpenAI-safe tool name actually sent to the provider. */
  wireName: string;
  /** The executable LangChain tool. */
  tool: DynamicStructuredTool;
  /** True when the tool can mutate state (fail-closed by default). */
  mutating: boolean;
};

/**
 * Bind-time gate of the execution mode: `ask` keeps only read-only bindings
 * (`mutating === false`), `auto` keeps the whole set. Input order is preserved.
 */
export function filterLangChainToolsForMode<T extends { mutating: boolean }>(
  bindings: ReadonlyArray<T>,
  mode: ToolMode,
): Array<T> {
  return mode === 'ask' ? bindings.filter((binding) => !binding.mutating) : [...bindings];
}

/**
 * Dependencies of `executeToolView`: every source is injected explicitly
 * (`dispatch`, worker registry, MCP client), nothing is read from globals.
 * `dispatch` stays the single settlement point for the native registry.
 */
export type ToolViewExecutorDeps = {
  /** Tool registry dispatcher (same instance as the HTTP/Nest one). */
  dispatch: ToolDispatchService['dispatch'];
  /** Gated project directory + session of the current turn. */
  context: ToolContext;
  /** Worker tool registry (`native:` ids it declares in `workerIds`). */
  worker?: {
    invoke(
      id: string,
      input: Record<string, unknown>,
      context: { cwd: string },
    ): Promise<{ output: Record<string, unknown> }>;
  };
  /** Native ids owned by the worker registry (never duplicated in dispatch). */
  workerIds?: ReadonlySet<string>;
  /** Working directory of a worker call (defaults to `context.directory`). */
  workerCwd?: string;
  /** MCP client (single JSON-RPC round trip per call). */
  mcp?: {
    callTool(name: string, callArguments: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  /** MCP read-only hints keyed by bare tool name; missing hint means mutating. */
  mcpReadOnly?: ReadonlyMap<string, boolean>;
};

/** Native views that only read state — everything else native stays mutating. */
const READ_ONLY_NATIVE_VIEW_IDS: ReadonlySet<string> = new Set([
  'native:read',
  'native:glob',
  'native:grep',
  'native:todo',
  'native:git.recon',
]);

/** Characters forbidden in an OpenAI function name, plus the 64-char cap. */
const WIRE_NAME_FORBIDDEN: RegExp = /[^A-Za-z0-9_-]/g;
const WIRE_NAME_MAX_LENGTH: number = 64;
const WIRE_NAME_FALLBACK: string = 'tool';

/** `error: <message>` text (never a thrown stack) for every LangChain tool func. */
function errorText(error: unknown, fallback: string = 'tool failed'): string {
  return `error: ${error instanceof Error ? error.message : fallback}`;
}

/** JSON text or null when the value cannot be serialized (cyclic input). */
function jsonText(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Splits `<prefix>:<name>`; an id without a colon keeps an empty prefix. */
function splitToolViewId(id: string): { prefix: string; name: string } {
  const index: number = id.indexOf(':');
  if (index < 0) return { prefix: '', name: id };
  return { prefix: id.slice(0, index), name: id.slice(index + 1) };
}

/**
 * Executes one `ToolView` and always answers model text (never throws).
 *
 * - `mcp:<name>` → the injected MCP client (`error: mcp client is not configured`
 *   without one), result is JSON.
 * - `native:<name>` the worker registry declares → worker invoke, result is JSON.
 * - `native:<name>` otherwise and every other prefix (`skill:` etc.) → dispatch,
 *   which itself settles unknown/invalid calls as error-results.
 */
export async function executeToolView(
  view: ToolView,
  input: Record<string, unknown>,
  deps: ToolViewExecutorDeps,
): Promise<string> {
  // type: destructuring — the explicit syntax cannot restate a two-field
  // destructure of `splitToolViewId`'s return shape.
  const { prefix, name } = splitToolViewId(view.id);

  if (prefix === 'mcp') {
    if (!deps.mcp) return 'error: mcp client is not configured';
    try {
      const output: Record<string, unknown> = await deps.mcp.callTool(name, input);
      return jsonText(output) ?? 'error: invalid tool input';
    } catch (error) {
      return errorText(error);
    }
  }

  if (prefix === 'native' && deps.worker && deps.workerIds?.has(view.id)) {
    try {
      const result: { output: Record<string, unknown> } = await deps.worker.invoke(
        view.id,
        input,
        {
          cwd: deps.workerCwd ?? deps.context.directory,
        },
      );
      return jsonText(result.output) ?? 'error: invalid tool input';
    } catch (error) {
      return errorText(error);
    }
  }

  const argumentsJson: string | null = jsonText(input);
  if (argumentsJson === null) return 'error: invalid tool input';

  const settlements: Array<ToolSettlement> = await deps.dispatch(
    [{ id: view.id, name: prefix === 'native' ? name : view.id, arguments: argumentsJson }],
    deps.context,
  );
  const settlement: ToolSettlement | undefined = settlements[0];
  return settlement?.result ?? `error: tool "${view.id}" produced no result`;
}

/**
 * OpenAI-safe tool name: forbidden characters become `_`, the result is capped
 * at 64 chars and an empty result falls back to `tool`.
 */
export function wireToolName(id: string): string {
  const sanitized: string = id.replace(WIRE_NAME_FORBIDDEN, '_').slice(0, WIRE_NAME_MAX_LENGTH);
  return sanitized.length > 0 ? sanitized : WIRE_NAME_FALLBACK;
}

/** Resolves a wire-name collision inside one tool set (`_2`, `_3`, … suffixes). */
function uniqueWireName(id: string, used: Set<string>): string {
  const base: string = wireToolName(id);
  let name: string = base;
  let suffix: number = 2;
  while (used.has(name)) {
    const tail: string = `_${suffix}`;
    name = `${base.slice(0, WIRE_NAME_MAX_LENGTH - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

/**
 * Converts `view.inputSchema` to a zod schema. Unsupported/`$ref`-heavy
 * schemas fall back to a permissive object so a broken view never blocks the
 * whole tool set.
 */
function toolInputSchema(view: ToolView): z.ZodType {
  const raw: unknown = view.inputSchema;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return z.record(z.string(), z.unknown());
  }
  try {
    return z.fromJSONSchema(raw as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

/**
 * Mutation flag of one view (fail-closed):
 * - `native:read|glob|grep|todo|git.recon` → false,
 * - every other `native:*` (write/edit/patch/shell and unknown ids) → true,
 * - `mcp:<name>` → false only with an explicit `readOnly === true` hint,
 * - `skill:`/`subagent`/anything else → true.
 */
export function isMutatingToolView(
  view: ToolView,
  mcpReadOnly?: ReadonlyMap<string, boolean>,
): boolean {
  if (view.id.startsWith('mcp:')) {
    return mcpReadOnly?.get(view.id.slice('mcp:'.length)) !== true;
  }
  if (view.id.startsWith('native:')) {
    return !READ_ONLY_NATIVE_VIEW_IDS.has(view.id);
  }
  return true;
}

/**
 * Optional binding overrides (pure options, no DI).
 */
export type LangChainToolOptions = {
  /**
   * Wire name of one view. Native views must reach the dispatcher under their
   * BARE registry name (`read`, `write`, …): `ToolDispatchService` resolves by
   * that name and `isMutatingToolName` strips only the `native:` prefix, so a
   * `native_read` wire name would look like an unknown (mutating) tool. Absent
   * → the sanitized `view.id` (unchanged behaviour).
   */
  wireNameFor?: (view: ToolView) => string;
};

/**
 * Binds every `ToolView` to a `DynamicStructuredTool` — the only set handed to
 * `bindTools`. Names are sanitized and collision-free, mutation flags come
 * from `isMutatingToolView`, and every `func` delegates to `executeToolView`
 * (which settles through dispatch/worker/MCP; no direct dispatch call escapes).
 */
export function createLangChainTools(
  views: ReadonlyArray<ToolView>,
  deps: ToolViewExecutorDeps,
  options: LangChainToolOptions = {},
): Array<LangChainToolBinding> {
  const used: Set<string> = new Set<string>();
  return views.map((view) => {
    const baseName: string = options.wireNameFor ? options.wireNameFor(view) : view.id;
    const wireName: string = uniqueWireName(baseName, used);
    const tool: DynamicStructuredTool = new DynamicStructuredTool({
      name: wireName,
      description: view.description,
      schema: toolInputSchema(view),
      func: async (input) =>
        executeToolView(view, input as Record<string, unknown>, deps),
    });
    return {
      view,
      wireName,
      tool,
      mutating: isMutatingToolView(view, deps.mcpReadOnly),
    };
  });
}

/**
 * Subagent as a LangChain tool: the parent model only promises a prompt, the
 * job answers a `ToolSettlement` and its result (already an error-result on
 * failure) becomes the tool output. The subagent never executes provider tools.
 */
export function createSubagentLangChainTool(
  deps: {
    run(request: {
      agentId: string;
      prompt: string;
      userId: string;
      correlationId?: string;
      callID?: string;
    }): Promise<ToolSettlement>;
  },
  options: { agentId: string; userId: string; correlationId?: string },
): { tool: DynamicStructuredTool; wireName: string; mutating: true } {
  const wireName: string = wireToolName(`subagent.${options.agentId}`);
  const tool: DynamicStructuredTool = new DynamicStructuredTool({
    name: wireName,
    description: `Run the '${options.agentId}' subagent (LangChain tool only; the subagent cannot execute provider tools).`,
    schema: z.object({ prompt: z.string().min(1) }),
    func: async (input, _runManager, config) => {
      const callID: string | undefined = (config as ToolRunnableConfig | undefined)?.toolCall?.id;
      try {
        const settlement: ToolSettlement = await deps.run({
          agentId: options.agentId,
          prompt: input.prompt,
          userId: options.userId,
          ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
          ...(callID !== undefined ? { callID } : {}),
        });
        return settlement.result;
      } catch (error) {
        return errorText(error, 'subagent failed');
      }
    },
  });
  return { tool, wireName, mutating: true };
}

/**
 * MCP tools as LangChain tools over the existing `McpClient`: the MCP result
 * object is JSON text, failures are error-results. Read-only comes only from
 * the descriptor hint; a missing hint keeps the tool mutating (fail-closed).
 */
export function createMcpLangChainTools(
  client: {
    callTool(name: string, callArguments: Record<string, unknown>): Promise<Record<string, unknown>>;
  },
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    readOnly?: boolean;
  }>,
): Array<LangChainToolBinding> {
  const readOnly: Map<string, boolean> = new Map<string, boolean>();
  for (const descriptor of tools) {
    // Bare MCP tool name: `isMutatingToolView` strips the `mcp:` prefix.
    if (descriptor.readOnly === true) readOnly.set(descriptor.name, true);
  }
  const views: Array<ToolView> = tools.map((descriptor) => ({
    id: `mcp:${descriptor.name}`,
    title: descriptor.name,
    description: descriptor.description ?? descriptor.name,
    inputSchema: descriptor.inputSchema ?? { type: 'object', properties: {} },
  }));
  return createLangChainTools(views, {
    // `mcp:` ids are resolved before dispatch, so these two are unreachable;
    // the dispatch stub answers an honest error-result instead of a fake success.
    dispatch: async (calls) =>
      calls.map((call) => ({
        callID: call.id,
        name: call.name,
        result: `error: mcp tool "${call.name}" cannot be dispatched`,
      })),
    context: { directory: '' },
    mcp: client,
    mcpReadOnly: readOnly,
  });
}
