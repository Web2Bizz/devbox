import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AskAgent } from './ask.agent';

/**
 * AgentsModule — registry of AI agents (scaffold: Ask only, mock answers).
 */
@Module({
  controllers: [AgentsController],
  providers: [AgentsService, AskAgent],
  exports: [AgentsService],
})
export class AgentsModule {}
