import { Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import type { ToolSettlement } from '../../../tool-runtime/tool-runtime.types';
import { AgentsService } from '../../agents.service';
import { AgentRegistry, type AgentDefinition } from '../../agents.registry';

/** One subagent job: which agent answers, the prompt and its owner. */
export type SubagentJobRequest = {
  agentId: string;
  prompt: string;
  userId: string;
  correlationId?: string;
  /** Call id of the parent tool call (settlement correlation). */
  callID?: string;
};

/**
 * SubagentJobService — a subagent runs as an encapsulated job: the parent
 * hands a prompt in and receives a `ToolSettlement` back. No transport
 * handle, no session mutations, no exception escapes the job (a failed job
 * is an error-result the parent model can react to, same as tool dispatch).
 */
@Injectable()
export class SubagentJobService {
  private readonly logger: AppLogger = new AppLogger(SubagentJobService.name);

  constructor(
    private readonly agents: AgentsService,
    private readonly registry: AgentRegistry,
  ) {}

  async run(request: SubagentJobRequest): Promise<ToolSettlement> {
    const agent: AgentDefinition = this.registry.resolve(request.agentId);
    const callID: string = request.callID ?? Bun.randomUUIDv7();
    const name: string = `subagent.${agent.id}`;
    try {
      const answer: string = await this.agents.askQuestion(
        agent.id,
        request.prompt,
        request.userId,
        request.correlationId,
      );
      this.logger.info(`[agents] subagent done agent=${agent.id}`, request.correlationId);
      return { callID, name, result: answer };
    } catch (error) {
      this.logger.warn(`[agents] subagent failed agent=${agent.id}`, request.correlationId);
      this.logger.debug(error instanceof Error ? error.message : 'unknown');
      return {
        callID,
        name,
        result: `error: ${error instanceof Error ? error.message : 'subagent failed'}`,
      };
    }
  }
}
