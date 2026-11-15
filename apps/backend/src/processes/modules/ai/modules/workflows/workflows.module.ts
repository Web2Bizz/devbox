import { Module } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * WorkflowsModule — sibling module of Agents under ai/modules: orchestration
 * of the routed chain (decompose → steps → synthesize). Imported by the
 * sibling AgentsModule (executors layer) and assembled in AiModule, never
 * registered in AppModule directly.
 */
@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
