import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../../common/validation';
import { V1Endpoint } from '../../../common/http/api/version';
import { AgentsService } from './agents.service';
import {
  AgentDto,
  AskAnswerDto,
  askQuestionSchema,
  type AskQuestion,
} from './dto';

/**
 * AgentsController — list available AI agents + ask a question (mock).
 */
@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @V1Endpoint('List available AI agents')
  @ApiResponse({ status: 200, type: [AgentDto] })
  list(): AgentDto[] {
    return this.agents.list();
  }

  @Post(':agentId/ask')
  @V1Endpoint('Ask an AI agent a question (mock answer)')
  @ApiParam({ name: 'agentId', example: 'ask' })
  @ApiResponse({ status: 200, type: AskAnswerDto })
  @ApiResponse({ status: 404, description: 'agent not found' })
  async ask(
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(askQuestionSchema)) body: AskQuestion,
  ): Promise<AskAnswerDto> {
    const answer = await this.agents.askQuestion(agentId, body.question);
    return { agentId, answer };
  }
}
