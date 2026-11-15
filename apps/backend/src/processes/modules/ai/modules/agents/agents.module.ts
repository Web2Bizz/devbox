import { forwardRef, Module } from '@nestjs/common';
import { AgentsBootstrapService } from './agents.bootstrap';
import { AgentsController } from './agents.controller';
import { AgentsRegistryModule } from '../agents-registry/agents-registry.module';
import { AgentsService } from './agents.service';
import { AskAgent } from './ask.agent';
import { AutoAgent } from './auto.agent';
import { BackendAgent } from './backend.agent';
import { FrontendAgent } from './frontend.agent';
import { FullstackAgent } from './fullstack.agent';
import { ModesModule } from '../modes/modes.module';
import { SubagentModule } from '../subagent/subagent.module';
import { WorkflowsModule } from '../workflows/workflows.module';

/**
 * AgentsModule — EXECUTORS layer of the AI runtime plus the sibling mode /
 * workflow / subagent modules (flat ai/modules/ layout, concept: mode ≠
 * agent ≠ workflow):
 *
 * - MODES (`../modes/`): 'ask' | 'auto' selectors — which WORKFLOW runs
 *   (ModesService: 'ask' → 'single-answer', 'auto' → 'routed-chain').
 *   AskMode/AutoMode never answer anything themselves.
 * - WORKFLOWS (`../workflows/`): orchestration of the routed chain
 *   (WorkflowsService: decompose → steps → synthesize through one executor).
 * - SUBAGENT (`../subagent/`): encapsulated subagent jobs
 *   (SubagentJobService: prompt in, ToolSettlement out). The executors layer
 *   arrives through the SUBAGENT_AGENT_FACADE token bound in SubagentModule
 *   (useFactory on AgentsService/AgentsRegistryService), so the modules are
 *   linked only via forwardRef (no hard agents↔subagent cycle).
 * - REGISTRY (`../agents-registry/`): the single resolve/select/list source
 *   (AgentsRegistryService, dependency-free). The executors register their
 *   definitions through AgentsBootstrapService at boot (mirrors
 *   ToolsBootstrapService), so the registry never imports this layer and no
 *   agents↔agents-registry cycle exists (DI edge up, type-only edge down).
 * - EXECUTORS (this layer): AskAgent answers single-answer turns; AutoAgent
 *   runs the routed-chain workflow (Jev routing + WorkflowsService chain);
 *   Backend/Frontend/Fullstack are hidden domain executors; AgentsService is
 *   the facade dispatching by ModesService.
 *
 * The wire strings collide on purpose ('ask' mode vs AskAgent id 'ask'):
 * they are disambiguated by module + type (`AgentWorkMode` in modes vs the
 * executors' own ids). Public exports are AgentsService plus the
 * re-exported AgentsRegistryModule/SubagentModule (their services stay
 * available transitively) + the legacy TS-only AgentRegistry alias below,
 * so existing importers keep working. VaultService/CryptoService
 * come from the global CommonModule and OpencodeModelFetch from the global
 * OpencodeModule, no import needed.
 */
@Module({
  imports: [
    ModesModule,
    WorkflowsModule,
    forwardRef(() => SubagentModule),
    AgentsRegistryModule,
  ],
  controllers: [AgentsController],
  providers: [
    AgentsService,
    AskAgent,
    BackendAgent,
    FrontendAgent,
    FullstackAgent,
    AutoAgent,
    AgentsBootstrapService,
  ],
  exports: [AgentsService, AgentsRegistryModule, SubagentModule],
})
export class AgentsModule {}

/** Legacy barrel alias: `AgentRegistry` === `AgentsRegistryService` (same DI token). */
export { AgentsRegistryService as AgentRegistry } from '../agents-registry/agents-registry.service';
