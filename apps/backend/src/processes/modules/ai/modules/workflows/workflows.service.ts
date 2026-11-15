import { Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import {
  buildDecomposePrompt,
  buildStepPrompt,
  buildSynthesizePrompt,
  CONTEXT_LIMIT,
  parseSteps,
} from './utils/chain-steps';
import type { DomainExecutor, WorkflowSummary } from './workflows.types';

/**
 * WorkflowsService — orchestration of the routed chain (WORKFLOWS layer):
 * decompose → steps → synthesize, all by the chosen domain executor's view
 * (no direct runner calls here). Pure chain knowledge lives in
 * `utils/chain-steps` (prompt builders + parseSteps); this service adds the
 * Nest seams (DI token, logging) so executors (AutoAgent) run the chain
 * through it instead of inlining prompts.
 */
@Injectable()
export class WorkflowsService {
  constructor(private readonly logger: AppLogger = new AppLogger(WorkflowsService.name)) {}

  /** Picker list of the available workflows (fixed pair, definitions only). */
  listWorkflows(): Array<WorkflowSummary> {
    const workflows: Array<WorkflowSummary> = [
      {
        id: 'single-answer',
        name: 'Single answer',
        description: 'One direct answer, no steps',
      },
      {
        id: 'routed-chain',
        name: 'Routed chain',
        description: 'Decomposes the request and runs the steps with a domain executor',
      },
    ];
    return workflows;
  }

  /**
   * Runs decompose → steps → synthesize with one domain executor.
   * Fail-fast domain errors (404/401 key) propagate as-is; a step failure
   * aborts the chain (no partial mock answers).
   */
  async runRoutedChain(
    executor: DomainExecutor,
    question: string,
    userId: string,
    correlationId?: string,
  ): Promise<string> {
    this.logger.info('[agents] auto decompose', correlationId);
    const plan: string = await executor.ask(buildDecomposePrompt(question), userId, correlationId);
    let steps: Array<string> = parseSteps(plan);
    if (steps.length === 0) {
      this.logger.info('[agents] auto single-step fallback', correlationId);
      steps = [question];
    } else {
      this.logger.info(`[agents] auto steps count=${steps.length}`, correlationId);
    }

    const results: Array<string> = [];
    for (let index: number = 0; index < steps.length; index++) {
      this.logger.info(
        `[agents] auto step start index=${index + 1} total=${steps.length}`,
        correlationId,
      );
      const context: string = results.join('\n').slice(-CONTEXT_LIMIT);
      try {
        const stepResult: string = await executor.ask(
          buildStepPrompt(question, index + 1, steps.length, steps[index], context),
          userId,
          correlationId,
        );
        results.push(stepResult);
        this.logger.info(
          `[agents] auto step done index=${index + 1} total=${steps.length}`,
          correlationId,
        );
      } catch (error) {
        this.logger.warn(
          `[agents] auto step failed index=${index + 1} total=${steps.length}`,
          correlationId,
        );
        throw error;
      }
    }

    this.logger.info('[agents] auto synthesize', correlationId);
    return executor.ask(
      buildSynthesizePrompt(question, results.join('\n').slice(-CONTEXT_LIMIT)),
      userId,
      correlationId,
    );
  }
}
