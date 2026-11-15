import { Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';

/**
 * ToolRegistryModule — tool runtime module under ai/modules (sibling of
 * tool-runtime/tools) (CoC backend §2). Owns the single registry provider;
 * imported by the parent ToolRuntimeModule and by ToolDispatchModule, never
 * registered in AppModule directly.
 */
@Module({
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolRegistryModule {}
