import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AskAgent } from './ask.agent';
import { AutoAgent } from './auto.agent';
import { BackendAgent } from './backend.agent';
import { FrontendAgent } from './frontend.agent';
import { FullstackAgent } from './fullstack.agent';

/**
 * AgentsModule — registry of AI agents (Ask answers through the harness-owned
 * runner behind the caller's key, Backend/Frontend/Fullstack with domain
 * system prompts, Auto chains via the Jev-routed domain executor;
 * SessionRunnerService comes from the global CommonModule, no import needed).
 */
@Module({
  controllers: [AgentsController],
  providers: [AgentsService, AskAgent, BackendAgent, FrontendAgent, FullstackAgent, AutoAgent],
  exports: [AgentsService],
})
export class AgentsModule {}
