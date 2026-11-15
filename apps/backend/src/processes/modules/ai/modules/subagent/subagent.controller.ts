import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../../auth/jwt-auth.guard';
import { SubagentJobService } from './subagent-job.service';
import { SubagentDto } from './subagent.dto';
import type { SubagentExecutorSummary } from './subagent.types';

/**
 * SubagentController — owns only the subagent routes (CoC backend §1.1).
 * Read-only picker of the subagent-capable executors; jobs themselves run
 * in-process through SubagentJobService (no transport handle, no HTTP run).
 */
@ApiTags('agents-subagents')
@ApiBearerAuth()
@Controller('agents/subagents')
@UseGuards(JwtAuthGuard)
export class SubagentController {
  constructor(private readonly jobs: SubagentJobService) {}

  @Get()
  @ApiOperation({ summary: 'List subagent-capable executors' })
  @ApiResponse({ status: 200, type: [SubagentDto] })
  list(): Array<SubagentDto> {
    const summaries: Array<SubagentExecutorSummary> = this.jobs.listExecutors();
    const dtos: Array<SubagentDto> = summaries.map((summary) => ({
      id: summary.id,
      name: summary.name,
      description: summary.description,
    }));
    return dtos;
  }
}
