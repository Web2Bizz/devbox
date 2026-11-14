import { Module } from '@nestjs/common';
import { AgentsRegistryService } from './agents-registry.service';

/**
 * AgentsRegistryModule — agents-registry module under ai/modules (sibling of
 * the executors `agents` module, CoC backend §2). Owns the single registry
 * provider; imported by the parent AgentsModule, never registered in
 * AppModule directly.
 */
@Module({
  providers: [AgentsRegistryService],
  exports: [AgentsRegistryService],
})
export class AgentsRegistryModule {}
