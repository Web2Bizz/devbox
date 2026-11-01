import { Module } from '@nestjs/common';
import { AgentsModule } from './modules/agents/agents.module';
import { OpencodeModule } from './modules/opencode/opencode.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { WorkersModule } from './modules/workers/workers.module';

/**
 * AiModule — aggregate module without its own controller.
 * Submodules: AgentsModule (with controller), WorkersModule (no controller),
 * OpencodeModule (global opencode upstream transport + mirror, re-exported
 * so existing consumers keep working), SessionsModule (/api/sessions* domain).
 */
@Module({
  imports: [AgentsModule, WorkersModule, OpencodeModule, SessionsModule],
  exports: [OpencodeModule],
})
export class AiModule {}
