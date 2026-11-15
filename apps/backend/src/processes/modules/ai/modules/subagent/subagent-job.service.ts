import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import type { ToolSettlement } from '../tool-runtime/tool-runtime.types';
import {
  buildSubagentErrorSettlement,
  buildSubagentSettlement,
} from './utils/subagent';
import {
  SUBAGENT_AGENT_FACADE,
  type SubagentAgentFacade,
  type SubagentExecutorSummary,
  type SubagentJobRequest,
} from './subagent.types';

/**
 * SubagentJobService — a subagent runs as an encapsulated job: the parent
 * hands a prompt in and receives a `ToolSettlement` back. No transport
 * handle, no session mutations, no exception escapes the job (a failed job
 * is an error-result the parent model can react to, same as tool dispatch).
 *
 * The executors layer arrives only through the `SubagentAgentFacade` token
 * (bound in SubagentModule via forwardRef to AgentsModule): the modules are
 * linked only via forwardRef, so no hard agents↔subagent module cycle exists.
 */
@Injectable()
export class SubagentJobService {
  private readonly logger: AppLogger = new AppLogger(SubagentJobService.name);

  constructor(
    @Inject(SUBAGENT_AGENT_FACADE) private readonly facade: SubagentAgentFacade,
  ) {}

  /** Picker list of the subagent-capable executors (hidden domain agents). */
  listExecutors(): Array<SubagentExecutorSummary> {
    return this.facade
      .listAll()
      .filter((agent) => agent.mode === 'subagent')
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
      }));
  }

  async run(request: SubagentJobRequest): Promise<ToolSettlement> {
    const agentId: string = this.facade.resolve(request.agentId).id;
    const callID: string = request.callID ?? Bun.randomUUIDv7();
    try {
      const answer: string = await this.facade.askQuestion(
        agentId,
        request.prompt,
        request.userId,
        request.correlationId,
      );
      this.logger.info(`[agents] subagent done agent=${agentId}`, request.correlationId);
      return buildSubagentSettlement(callID, agentId, answer);
    } catch (error) {
      this.logger.warn(`[agents] subagent failed agent=${agentId}`, request.correlationId);
      this.logger.debug(error instanceof Error ? error.message : 'unknown');
      return buildSubagentErrorSettlement(callID, agentId, error);
    }
  }
}
