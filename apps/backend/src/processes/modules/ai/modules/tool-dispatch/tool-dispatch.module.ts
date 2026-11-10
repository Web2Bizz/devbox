import { Module } from '@nestjs/common';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';
import { ToolDispatchService } from './tool-dispatch.service';

/**
 * ToolDispatchModule — tool runtime module under ai/modules (sibling of
 * tool-runtime/tools) (CoC backend §2). Settles model tool calls against the
 * registry; exported by the parent ToolRuntimeModule so the runner injects the
 * same dispatch instance.
 */
@Module({
  imports: [ToolRegistryModule],
  providers: [ToolDispatchService],
  exports: [ToolDispatchService],
})
export class ToolDispatchModule {}
