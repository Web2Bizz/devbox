import { Module } from '@nestjs/common';
import { AgentsModule } from './modules/agents/agents.module';
import { OpencodeModule } from './modules/opencode/opencode.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { WorkersModule } from '../workers/workers.module';

/**
 * AiModule — aggregate module without its own controller.
 * Submodules: AgentsModule (with controller), OpencodeModule (global opencode
 * upstream transport — unversioned mirror removed; re-exported so existing
 * consumers keep working), SessionsModule (/api/v1/sessions* domain). WorkersModule is a
 * sibling inside the processes scope (no controller) and is mounted here so
 * the AI runtime and its background workers boot together.
 */
@Module({
  imports: [AgentsModule, WorkersModule, OpencodeModule, SessionsModule],
  exports: [OpencodeModule],
})
export class AiModule {}
