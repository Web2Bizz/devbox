import { Module } from '@nestjs/common';
import { AiModule } from './modules/ai/ai.module';
import { RunsModule } from './modules/runs/runs.module';
import { WorkersModule } from './modules/workers/workers.module';

/**
 * ProcessesModule — Processes scope aggregate (CoC v2 nested under modules/).
 * Owns the HTTP entries inside ai/* (sessions/opencode/agents), the runs
 * surface (/api/runs*, agent-harness) and the workers scaffold (no routes).
 * Processes depends on Common + Organization, never the other way round.
 */
@Module({
  imports: [AiModule, RunsModule, WorkersModule],
  exports: [AiModule, RunsModule],
})
export class ProcessesModule {}
