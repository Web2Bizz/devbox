import { Module } from '@nestjs/common';
import { AgentsModule } from './modules/agents/agents.module';
import { ModesModule } from './modules/modes/modes.module';
import { OpencodeModule } from './modules/opencode/opencode.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { SubagentModule } from './modules/subagent/subagent.module';
import { ToolsModule } from './modules/tools/tools.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { WorkersModule } from '../workers/workers.module';

/**
 * AiModule — aggregate module without its own controller.
 * Submodules: AgentsModule (with controller), ModesModule, WorkflowsModule,
 * SubagentModule (flat siblings of the executors layer), OpencodeModule
 * (global opencode upstream transport — unversioned mirror removed;
 * re-exported so existing consumers keep working), SessionsModule
 * (/api/v1/sessions* domain). WorkersModule is a sibling inside the
 * processes scope (no controller) and is mounted here so the AI runtime and
 * its background workers boot together.
 */
@Module({
  imports: [
    AgentsModule,
    ModesModule,
    WorkflowsModule,
    SubagentModule,
    WorkersModule,
    OpencodeModule,
    ToolsModule,
    SessionsModule,
  ],
  exports: [OpencodeModule],
})
export class AiModule {}
