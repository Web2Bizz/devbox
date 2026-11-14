import { Module } from '@nestjs/common';
import { ModesController } from './modes.controller';
import { ModesService } from './modes.service';

/**
 * ModesModule — sibling module of Agents under ai/modules: the work-mode
 * selector (mode → workflow choice). NOT executors: AskMode/AutoMode select
 * the 'single-answer' / 'routed-chain' workflow, while AskAgent/AutoAgent in
 * the sibling agents layer execute it. Imported by the sibling AgentsModule
 * (executors layer) and assembled in AiModule, never registered in AppModule
 * directly.
 */
@Module({
  controllers: [ModesController],
  providers: [ModesService],
  exports: [ModesService],
})
export class ModesModule {}
