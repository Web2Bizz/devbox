import { Injectable, NotFoundException } from '@nestjs/common';
import { AskAgent } from './ask.agent';
import type { AgentDto } from './dto';

/**
 * Registry of available AI agents (scaffold: Ask only, mock answers).
 */
@Injectable()
export class AgentsService {
  constructor(private readonly ask: AskAgent) {}

  list(): AgentDto[] {
    return [
      { id: this.ask.id, name: this.ask.name, description: this.ask.description },
    ];
  }

  async askQuestion(agentId: string, question: string): Promise<string> {
    if (agentId !== this.ask.id) {
      throw new NotFoundException(`Agent '${agentId}' not found`);
    }
    return this.ask.ask(question);
  }
}
