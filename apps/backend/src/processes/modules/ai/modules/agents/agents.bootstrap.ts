import { Injectable } from '@nestjs/common';
import { AgentsRegistryService } from '../agents-registry/agents-registry.service';
import type { AgentDefinition } from '../agents-registry/agents-registry.types';
import { AskAgent } from './ask.agent';
import { AutoAgent } from './auto.agent';
import { BackendAgent } from './backend.agent';
import { FrontendAgent } from './frontend.agent';
import { FullstackAgent } from './fullstack.agent';

/**
 * Registers every executor with the registry once at boot. A separate
 * provider (not the registry constructor) keeps the registry dependency-free
 * and lets specs register only the definitions they exercise (mirrors
 * ToolsBootstrapService in the sibling `tools` module).
 */
@Injectable()
export class AgentsBootstrapService {
  constructor(
    private readonly registry: AgentsRegistryService,
    private readonly ask: AskAgent,
    private readonly auto: AutoAgent,
    private readonly backend: BackendAgent,
    private readonly frontend: FrontendAgent,
    private readonly fullstack: FullstackAgent,
  ) {
    const definitions: Array<AgentDefinition> = [
      {
        id: this.ask.id,
        name: this.ask.name,
        description: this.ask.description,
        hidden: false,
        mode: 'primary',
      },
      {
        id: this.auto.id,
        name: this.auto.name,
        description: this.auto.description,
        hidden: false,
        mode: 'primary',
      },
      {
        id: this.backend.id,
        name: this.backend.name,
        description: this.backend.description,
        hidden: true,
        mode: 'subagent',
      },
      {
        id: this.frontend.id,
        name: this.frontend.name,
        description: this.frontend.description,
        hidden: true,
        mode: 'subagent',
      },
      {
        id: this.fullstack.id,
        name: this.fullstack.name,
        description: this.fullstack.description,
        hidden: true,
        mode: 'subagent',
      },
    ];
    this.registry.registerAll(definitions);
  }
}
