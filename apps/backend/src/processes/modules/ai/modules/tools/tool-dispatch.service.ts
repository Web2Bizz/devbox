import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import { ToolRegistryService } from './tool-registry.service';
import type { ToolCall, ToolContext, ToolSettlement } from './tool.types';

/** Default pool size: bounded, never one fiber per call (NestJS protection). */
export const DEFAULT_TOOL_CONCURRENCY = 4;

/** Error-result text (never a thrown stack): the model reads it and may retry. */
function errorResult(call: ToolCall, reason: string): ToolSettlement {
  return { callID: call.id, name: call.name, result: `error: ${reason}` };
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
  ): Promise<Array<ToolSettlement>> {
    if (calls.length === 0) return [];
    const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, calls.length));
    const results = new Array<ToolSettlement>(calls.length);
    let cursor = 0;

    const lane = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= calls.length) return;
        const call = calls[index] as ToolCall;
        results[index] = await this.runOne(call, context);
      }
    };

    await Promise.all(Array.from({ length: lanes }, () => lane()));
    return results;
  }

  private async runOne(call: ToolCall, context: ToolContext): Promise<ToolSettlement> {
    const tool = this.registry.resolve(call.name);
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
    try {
      const result = await tool.execute(input, context);
      return { callID: call.id, name: call.name, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'tool failed';
      this.logger.warn(`[tools] call failed name=${call.name} code=tool_error`);
      this.logger.debug(message);
      return errorResult(call, message);
    }
  }
}
