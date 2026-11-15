import { Injectable } from '@nestjs/common';
import { AskAgent } from './ask.agent';
import { AutoAgent } from './auto.agent';
import type { AgentDto } from './agents.dto';
import { AgentsRegistryService } from '../agents-registry/agents-registry.service';
import { ModesService } from '../modes/modes.service';
import type { ModeSelection } from '../modes/modes.types';

/**
 * AgentsService — facade of the EXECUTORS layer (AskAgent + AutoAgent answer
 * directly; Backend/Frontend/Fullstack stay hidden executors provided here
 * for Auto's direct injection). The MODE → WORKFLOW choice lives in
 * ModesService (sibling ../modes/): 'ask' mode → 'single-answer' workflow
 * (AskAgent), 'auto' mode → 'routed-chain' workflow (AutoAgent via
 * WorkflowsService). Unknown ids throw the honest 404 from ModesService.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly modes: ModesService,
    private readonly ask: AskAgent,
    private readonly auto: AutoAgent,
    private readonly registry: AgentsRegistryService,
  ) {}

  list(): Array<AgentDto> {
    return this.registry.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
    }));
  }

  async askQuestion(
    agentId: string,
    question: string,
    userId: string,
    correlationId?: string,
  ): Promise<string> {
    const selection: ModeSelection = this.modes.resolve(agentId, correlationId);
    if (selection.workflow === 'single-answer') {
      return this.ask.ask(question, userId, correlationId);
    }
    return this.auto.ask(question, userId, correlationId);
  }
}
