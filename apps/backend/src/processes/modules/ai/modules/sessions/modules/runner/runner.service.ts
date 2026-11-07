import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../../../common/logger';
import { ToolDispatchService } from '../../../tools/tool-dispatch.service';
import type { ToolSettlement } from '../../../tools/tool.types';
import {
  addUsage,
  type LoopMessage,
  type LoopStep,
  nextRequest,
  pendingCalls,
  stepMessages,
  type StepRequest,
  type TokenUsage,
  type TurnFrame,
} from './loop';
import { assertStepBudget, DEFAULT_MAX_STEPS } from './max-steps';
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from './retry';

/** Transport adapter: one model step for the current request/messages. */
export type StepExecutor = (
  request: StepRequest,
  messages: Array<LoopMessage>,
) => Promise<LoopStep>;

/** Frame sink (the harness maps these onto SSE frames). */
export type PublishFrame = (frame: TurnFrame) => void;

export type RunTurnRequest = {
  sessionId: string;
  directory: string;
  messages: Array<LoopMessage>;
  step: StepExecutor;
  publish?: PublishFrame;
  concurrency?: number;
  maxSteps?: number;
  retry?: RetryPolicy;
};

export type RunTurnResult = {
  text: string;
  steps: number;
  finishReason: string;
  settlements: Array<ToolSettlement>;
  usage: TokenUsage;
};

/**
 * SessionRunnerService — step → dispatch → nextRequest orchestration.
 *
 * Transport-agnostic by design: the caller supplies the single-step executor
 * (model call) and the frame sink. Protections are structural, not optional:
 * a hard max-steps budget (`max-steps.ts`) and bounded per-step retries
 * (`retry.ts`). Tool calls settle in call order through the shared dispatch
 * (unknown tool / bad JSON / jail escape = error-result, never a throw).
 */
@Injectable()
export class SessionTurnRunnerService {
  private readonly logger: AppLogger = new AppLogger(SessionTurnRunnerService.name);

  constructor(private readonly dispatch: ToolDispatchService) {}

  async runTurn(request: RunTurnRequest): Promise<RunTurnResult> {
    const maxSteps = request.maxSteps ?? DEFAULT_MAX_STEPS;
    const concurrency = request.concurrency;
    const retry = request.retry ?? DEFAULT_RETRY_POLICY;
    const publish = request.publish ?? (() => undefined);
    let messages = [...request.messages];
    let usage: TokenUsage = { input: 0, output: 0 };
    let settlements: Array<ToolSettlement> = [];
    const stepIndex = 0;

    for (let index = stepIndex; ; index += 1) {
      assertStepBudget(index, maxSteps);
      publish({ type: 'step-start', data: { stepIndex: index } });
      const step = await withRetry(() => request.step(nextRequest({ text: '', calls: [], finishReason: null }, index), messages), retry);
      usage = addUsage(usage, step.usage);
      publish({
        type: 'step-finish',
        data: { stepIndex: index, finishReason: step.finishReason ?? '', text: step.text },
      });
      const calls = pendingCalls(step);
      if (calls.length === 0) {
        publish({
          type: 'finish',
          data: { finishReason: step.finishReason ?? 'stop', text: step.text },
        });
        this.logger.info(
          `[runner] turn done steps=${index + 1} tools=${settlements.length}`,
        );
        return {
          text: step.text,
          steps: index + 1,
          finishReason: step.finishReason ?? 'stop',
          settlements,
          usage,
        };
      }
      const round = await this.dispatch.dispatch(
        calls,
        { directory: request.directory, sessionId: request.sessionId },
        concurrency,
      );
      for (const settlement of round) {
        publish({ type: 'tool-result', data: { ...settlement } });
      }
      settlements = [...settlements, ...round];
      messages = [...messages, ...stepMessages(step, round)];
    }
  }
}
