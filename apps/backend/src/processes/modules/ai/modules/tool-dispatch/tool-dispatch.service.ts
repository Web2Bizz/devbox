import { Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { shellCommandRejection } from '../tools/shell.tool';
import type { ToolCall, ToolContext, ToolHandler, ToolSettlement } from '../tool-runtime/tool-runtime.types';
import { ToolRegistryService } from '../tool-registry/tool-registry.service';

/** Default pool size: bounded, never one fiber per call (NestJS protection). */
export const DEFAULT_TOOL_CONCURRENCY: number = 4;

/**
 * First answer of `ToolEffectsStore.begin`:
 * - `new` — the effect was not seen yet and is now reserved (`in-progress`),
 * - `committed` — the effect already ran, `result` is its settled string
 *   (replayed as-is, handler is not called),
 * - `in-progress` — another dispatch currently owns the effect (duplicate in
 *   the same round): answered as an error-result, never executed.
 */
export type ToolEffectBegin =
  | { state: 'new' }
  | { state: 'committed'; result: string }
  | { state: 'in-progress' };

/**
 * Idempotency store of tool effects keyed by `effectKey`
 * (`runId + stepSeq + toolCallId`). `begin` reserves/reports the state, and
 * `commit` records the settled result — error-results included, so a replay
 * never re-runs an effect that already failed.
 */
export type ToolEffectsStore = {
  begin(effectKey: string): Promise<ToolEffectBegin>;
  commit(effectKey: string, result: string): Promise<void>;
};

/**
 * In-process `ToolEffectsStore`: a Map of effect states. `begin` is atomic
 * (the Map is touched synchronously before the promise resolves), so two calls
 * with the same key in one `dispatch` can never both observe `new`.
 */
export class InMemoryToolEffectsStore implements ToolEffectsStore {
  private readonly entries: Map<
    string,
    { state: 'in-progress' } | { state: 'committed'; result: string }
  > = new Map<string, { state: 'in-progress' } | { state: 'committed'; result: string }>();

  async begin(effectKey: string): Promise<ToolEffectBegin> {
    const entry:
      | { state: 'in-progress' }
      | { state: 'committed'; result: string }
      | undefined = this.entries.get(effectKey);
    if (!entry) {
      this.entries.set(effectKey, { state: 'in-progress' });
      return { state: 'new' };
    }
    if (entry.state === 'committed') {
      return { state: 'committed', result: entry.result };
    }
    return { state: 'in-progress' };
  }

  async commit(effectKey: string, result: string): Promise<void> {
    this.entries.set(effectKey, { state: 'committed', result });
  }
}

/** Error-result text (never a thrown stack): the model reads it and may retry. */
function errorResult(call: ToolCall, reason: string): ToolSettlement {
  return { callID: call.id, name: call.name, result: `error: ${reason}` };
}

/** Tool names that only read state — every other name stays mutating. */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'glob', 'grep', 'todo']);

/** Bare name: strips the `native:` namespace prefix, never a deeper segment. */
function bareToolName(name: string): string {
  return name.startsWith('native:') ? name.slice('native:'.length) : name;
}

/**
 * Mutation flag of a dispatched tool call (fail-closed): `read`/`glob`/`grep`/
 * `todo` are read-only; `write`/`edit`/`patch`/`shell` and every unknown name
 * are mutating. The `native:` prefix is stripped before the lookup.
 */
export function isMutatingToolName(name: string): boolean {
  return !READ_ONLY_TOOL_NAMES.has(bareToolName(name));
}

/**
 * ToolDispatchService — donor `dispatch/runTools` semantics:
 *
 * - unknown tool → error-result (no exception),
 * - invalid JSON arguments → error-result with a retry hint,
 * - jail escape / handler failure → error-result (`error: …`),
 * - settlement order === call order (results[] maps 1:1),
 * - concurrency is BOUNDED (`concurrency` worker lanes over the input),
 *   never an unbounded Promise.all over model-provided calls.
 */
@Injectable()
export class ToolDispatchService {
  private readonly logger: AppLogger = new AppLogger(ToolDispatchService.name);

  constructor(private readonly registry: ToolRegistryService) {}

  async dispatch(
    calls: Array<ToolCall>,
    context: ToolContext,
    concurrency: number = DEFAULT_TOOL_CONCURRENCY,
    effects?: ToolEffectsStore,
  ): Promise<Array<ToolSettlement>> {
    if (calls.length === 0) return [];
    const lanes: number = Math.max(1, Math.min(Math.floor(concurrency) || 1, calls.length));
    const results: Array<ToolSettlement> = new Array<ToolSettlement>(calls.length);
    let cursor: number = 0;

    const lane: () => Promise<void> = async () => {
      for (;;) {
        const index: number = cursor;
        cursor += 1;
        if (index >= calls.length) return;
        const call: ToolCall = calls[index] as ToolCall;
        results[index] = await this.settle(call, context, effects);
      }
    };

    await Promise.all(Array.from({ length: lanes }, () => lane()));
    return results;
  }

  /**
   * Settles one call: keyed calls go through the effects store first
   * (committed → replay, in-progress → error-result, new → execute + commit).
   * Without `effectKey`/`effects` the call runs exactly as before.
   */
  private async settle(
    call: ToolCall,
    context: ToolContext,
    effects?: ToolEffectsStore,
  ): Promise<ToolSettlement> {
    if (!call.effectKey || !effects) return this.runOne(call, context);

    const begin: ToolEffectBegin = await effects.begin(call.effectKey);
    if (begin.state === 'committed') {
      return { callID: call.id, name: call.name, result: begin.result };
    }
    if (begin.state === 'in-progress') {
      this.logger.warn(`[tools] effect already in progress name=${call.name}`);
      return errorResult(call, 'effect already in progress');
    }
    const settlement: ToolSettlement = await this.runOne(call, context);
    // Error-results are committed too: a replay must not re-run the effect.
    await effects.commit(call.effectKey, settlement.result);
    return settlement;
  }

  private async runOne(call: ToolCall, context: ToolContext): Promise<ToolSettlement> {
    if (context.mode === 'ask' && isMutatingToolName(call.name)) {
      this.logger.warn(`[tools] ask mode refused name=${call.name}`);
      return errorResult(call, `tool "${call.name}" is not allowed in ask mode (read-only)`);
    }
    const tool: ToolHandler | null = this.registry.resolve(call.name);
    if (!tool) {
      this.logger.warn(`[tools] unknown tool name=${call.name}`);
      return errorResult(call, `unknown tool "${call.name}"`);
    }
    let input: unknown;
    try {
      input = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
    } catch {
      this.logger.warn(`[tools] invalid json name=${call.name}`);
      return errorResult(call, 'invalid JSON arguments, retry with valid JSON');
    }
    // Shell-batch assembly never reaches the handler: `shell` spawns with
    // `shell: false`, so chaining (`;`, `|`, `&`), `cd` and `KEY=value`
    // env-prefixes cannot execute and would only burn steps until max-steps.
    // Fail-fast here (before execute) with a retryable hint instead.
    if (bareToolName(call.name) === 'shell') {
      const command: unknown = (input as { command?: unknown }).command;
      if (typeof command === 'string') {
        const rejection: string | null = shellCommandRejection(command);
        if (rejection) {
          this.logger.warn(`[tools] shell batch rejected name=${call.name}`);
          return errorResult(call, rejection.replace(/^error:\s*/, ''));
        }
      }
    }
    try {
      const result: string = await tool.execute(input, context);
      return { callID: call.id, name: call.name, result };
    } catch (error) {
      const message: string = error instanceof Error ? error.message : 'tool failed';
      this.logger.warn(`[tools] call failed name=${call.name} code=tool_error`);
      this.logger.debug(message);
      return errorResult(call, message);
    }
  }
}
