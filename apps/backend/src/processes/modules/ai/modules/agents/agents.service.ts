import { Injectable, NotFoundException } from '@nestjs/common';
import { AskAgent } from './ask.agent';
import { AutoAgent } from './auto.agent';
import type { AgentDto } from './agents.dto';
import { AgentRegistry } from './agents.registry';

/**
 * Registry of visible AI agent modes (Ask = single-answer mode, Auto =
 * router mode). Backend/Frontend/Fullstack stay hidden executors: their
 * classes remain provided in AgentsModule for Auto's direct injection
 * (no cycle through this service), but they are never listed here and
 * never answered directly — Ask and Auto are the only callable ids.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly ask: AskAgent,
    private readonly auto: AutoAgent,
    private readonly registry: AgentRegistry,
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
    if (agentId === this.ask.id) {
      return this.ask.ask(question, userId, correlationId);
    }
    if (agentId === this.auto.id) {
      return this.auto.ask(question, userId, correlationId);
    }
    throw new NotFoundException(`Agent '${agentId}' not found`);
  }
}
