import { forwardRef, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AgentsRegistryModule } from '../agents-registry/agents-registry.module';
import { AgentsRegistryService } from '../agents-registry/agents-registry.service';
import type { AgentDefinition } from '../agents-registry/agents-registry.types';
import { AgentsService } from '../agents/agents.service';
import { SubagentController } from './subagent.controller';
import { SubagentJobService } from './subagent-job.service';
import {
  SUBAGENT_AGENT_FACADE,
  type SubagentAgentFacade,
} from './subagent.types';

/**
 * SubagentModule — sibling module of Agents under ai/modules: encapsulated
 * subagent jobs (prompt in, ToolSettlement out). The executors layer arrives
 * through the SUBAGENT_AGENT_FACADE token bound below (useFactory on
 * AgentsService/AgentsRegistryService), so this module imports AgentsModule
 * only via forwardRef (agents↔subagent cycle broken the standard Nest way).
 * AgentsRegistryModule stays dependency-free and is imported directly.
 * Assembled in AiModule, never registered in AppModule directly.
 */
@Module({
  imports: [forwardRef(() => AgentsModule), AgentsRegistryModule],
  controllers: [SubagentController],
  providers: [
    SubagentJobService,
    {
      provide: SUBAGENT_AGENT_FACADE,
      useFactory: (
        agents: AgentsService,
        registry: AgentsRegistryService,
      ): SubagentAgentFacade => ({
        askQuestion: (
          agentId: string,
          prompt: string,
          userId: string,
          correlationId?: string,
        ): Promise<string> => agents.askQuestion(agentId, prompt, userId, correlationId),
        resolve: (agentId?: string): AgentDefinition => registry.resolve(agentId),
        listAll: (): Array<AgentDefinition> => registry.all(),
      }),
      inject: [
        forwardRef(() => AgentsService) as unknown as typeof AgentsService,
        AgentsRegistryService,
      ],
    },
  ],
  exports: [SubagentJobService, SUBAGENT_AGENT_FACADE],
})
export class SubagentModule {}
