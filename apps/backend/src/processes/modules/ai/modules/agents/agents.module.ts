import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AskAgent } from './ask.agent';

/**
 * AgentsModule — registry of AI agents (Ask answers through the harness-owned
 * runner behind the caller's key; SessionRunnerService comes from the global
 * CommonModule, no import needed).
 */
@Module({
  controllers: [AgentsController],
  providers: [AgentsService, AskAgent],
  exports: [AgentsService],
})
export class AgentsModule {}
