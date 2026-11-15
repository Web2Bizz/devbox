import { Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { ModelGateway } from '../model-gateway/model-gateway';
import { type Executor, ModelGatewayExecutor } from './executor';

/** Prototype run-level executor ids (agent ids are wire values, not Class.name). */
const ASK_EXECUTOR_ID: string = 'ask';
const DEFAULT_EXECUTOR_ID: string = 'default';

/**
 * ExecutorRegistry — the step-level agent seam of the run engine.
 *
 * An Executor answers ONE run step (`llm.call`): the claim loop resolves it by
 * `run.agentId` (null → 'default') and streams ModelEvents. ModelGateway stays
 * the transport behind every executor, so adding a real agent never changes the
 * loop — only the registry. Duplicate ids throw: a silent overwrite would make
 * the journal's agent identity ambiguous.
 *
 * The chat-surface AskAgent (processes/ai/modules/agents) stays a separate
 * thing: it is a per-user, non-run path. Here `ask` is the RUN-level executor
 * over the gateway (prototype, no per-user key) — same id, different job.
 */
@Injectable()
export class ExecutorRegistry {
  private readonly executors: Map<string, Executor> = new Map<string, Executor>();

  constructor(
    gateway: ModelGateway,
    private readonly logger: AppLogger = new AppLogger(ExecutorRegistry.name),
  ) {
    this.register(new ModelGatewayExecutor(ASK_EXECUTOR_ID, gateway));
    this.register(new ModelGatewayExecutor(DEFAULT_EXECUTOR_ID, gateway));
  }

  /** Registers an executor; a duplicate id is a programming error, never a silent overwrite. */
  register(executor: Executor): void {
    if (this.executors.has(executor.id)) {
      throw new Error(`duplicate executor id ${executor.id}`);
    }
    this.executors.set(executor.id, executor);
    this.logger.debug(`[workers] executor registered id=${executor.id}`);
  }

  /** Registered ids in registration order (diagnostics/tests only). */
  listIds(): Array<string> {
    return Array.from(this.executors.keys());
  }

  /** Run-level resolution: unknown/absent agent id always lands on 'default'. */
  resolve(agentId: string | null): Executor {
    const executor: Executor | undefined =
      this.executors.get(agentId ?? DEFAULT_EXECUTOR_ID) ??
      this.executors.get(DEFAULT_EXECUTOR_ID);
    if (!executor) throw new Error('default executor is not registered');
    this.logger.debug(`[workers] executor resolved id=${executor.id}`);
    return executor;
  }
}
