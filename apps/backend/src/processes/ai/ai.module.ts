import { Module } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module';
import { OpencodeModule } from './opencode/opencode.module';
import { SessionsModule } from './sessions/sessions.module';
import { WorkersModule } from '../workers/workers.module';

/**
 * AiModule — Processes/AI aggregate without its own controller.
 * Submodules: AgentsModule (with controller), WorkersModule (no controller),
 * OpencodeModule (global opencode upstream transport + mirror, re-exported
 * so existing consumers keep working), SessionsModule (/api/sessions* domain).
 */
@Module({
  imports: [AgentsModule, WorkersModule, OpencodeModule, SessionsModule],
  exports: [OpencodeModule],
})
export class AiModule {}
