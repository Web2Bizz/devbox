import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../../auth/jwt-auth.guard';
import type { RequestIdentity } from '../../../../../auth/identity.service';
import { ReqUser } from '../../../../../auth/req-user.decorator';
import { ZodValidationPipe } from '../../../../../common/validation';
import { AgentsService } from './agents.service';
import {
  AgentDto,
  AskAnswerDto,
  askQuestionSchema,
  type AskQuestion,
} from './agents.dto';

/**
 * AgentsController — list available AI agents + ask a question (answers through
 * the harness-owned runner behind the caller's key, never a mock).
 * Bearer-guarded (JwtAuthGuard from the global auth module) and documented
 * with @ApiBearerAuth — no anonymous access to the agent registry.
 */
@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
@UseGuards(JwtAuthGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @ApiOperation({ summary: 'List available AI agents' })
  @ApiResponse({ status: 200, type: [AgentDto] })
  list(): Array<AgentDto> {
    return this.agents.list();
  }

  @Post(':agentId/ask')
  @ApiOperation({ summary: 'Ask an AI agent a question (harness runner answer)' })
  @ApiParam({ name: 'agentId', example: 'ask' })
  @ApiResponse({ status: 200, type: AskAnswerDto })
  @ApiResponse({ status: 404, description: 'agent not found' })
  async ask(
    @ReqUser() identity: RequestIdentity,
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(askQuestionSchema)) body: AskQuestion,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<AskAnswerDto> {
    const answer = await this.agents.askQuestion(
      agentId,
      body.question,
      identity.id,
      correlationId ?? '',
    );
    return { agentId, answer };
  }
}
