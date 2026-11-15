import { Module } from '@nestjs/common';
import { ToolDispatchModule } from '../tool-dispatch/tool-dispatch.module';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';

/**
 * ToolRuntimeModule — the tool runtime domain of the AI layer: shared tool
 * contracts (`tool-runtime.types.ts`), the registry that lists prompt-facing
 * definitions and the dispatcher that settles model calls into
 * model-readable results. It owns no handlers — the `tools` module registers
 * its handlers into the registry exported here and rides the same dispatch
 * instance from its own bootstrap.
 *
 * Both modules (siblings under ai/modules) are re-exported so a consumer
 * (the runner, the bootstrap) injects the single instance NestJS dedups by
 * module class.
 */
@Module({
  imports: [ToolRegistryModule, ToolDispatchModule],
  exports: [ToolRegistryModule, ToolDispatchModule],
})
export class ToolRuntimeModule {}
