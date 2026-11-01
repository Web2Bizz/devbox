import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';

/**
 * ProcessesModule — Processes scope aggregate mounted by AppModule for HTTP
 * routes only (sessions/opencode/agents). Domains never import it; entry is
 * an external HTTP request or a workers event carrying projectId (PLAN §3.5).
 *
 * WorkersModule is a scaffold sibling of ai/ and is imported by AiModule.
 */
@Module({
  imports: [AiModule],
  exports: [AiModule],
})
export class ProcessesModule {}
