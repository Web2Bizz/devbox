import { Module } from '@nestjs/common';
import { AiModule } from './modules/ai/ai.module';
import { WorkersModule } from './modules/workers/workers.module';

/**
 * ProcessesModule — Processes scope aggregate (CoC v2 nested under modules/).
 * No controller of its own: HTTP entries are the controllers inside ai/*
 * (sessions/opencode/agents) and the workers scaffold has no routes at all.
 * Processes depends on Common + Organization, never the other way round.
 */
@Module({
  imports: [AiModule, WorkersModule],
  exports: [AiModule],
})
export class ProcessesModule {}
