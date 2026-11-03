import { Injectable, NotFoundException } from '@nestjs/common';
import { AskAgent } from './ask.agent';
import type { AgentDto } from './agents.dto';

/**
 * Registry of available AI agents (Ask answers through the harness-owned runner).
 */
@Injectable()
export class AgentsService {
  constructor(private readonly ask: AskAgent) {}

  list(): Array<AgentDto> {
    return [
      { id: this.ask.id, name: this.ask.name, description: this.ask.description },
    ];
  }

  async askQuestion(
    agentId: string,
    question: string,
    userId: string,
    correlationId?: string,
  ): Promise<string> {
    if (agentId !== this.ask.id) {
      throw new NotFoundException(`Agent '${agentId}' not found`);
    }
    return this.ask.ask(question, userId, correlationId);
  }
}
