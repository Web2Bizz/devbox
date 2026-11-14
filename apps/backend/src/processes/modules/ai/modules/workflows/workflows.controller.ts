import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../../auth/jwt-auth.guard';
import { WorkflowsService } from './workflows.service';
import { WorkflowDto } from './workflows.dto';
import type { WorkflowSummary } from './workflows.types';

/**
 * WorkflowsController — owns only the workflows routes (CoC backend §1.1).
 * The sibling agents controller never serves workflow routes.
 */
@ApiTags('agents-workflows')
@ApiBearerAuth()
@Controller('agents/workflows')
@UseGuards(JwtAuthGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  @ApiOperation({ summary: 'List available agent workflows' })
  @ApiResponse({ status: 200, type: [WorkflowDto] })
  list(): Array<WorkflowDto> {
    const summaries: Array<WorkflowSummary> = this.workflows.listWorkflows();
    const dtos: Array<WorkflowDto> = summaries.map((summary) => ({
      id: summary.id,
      name: summary.name,
      description: summary.description,
    }));
    return dtos;
  }
}
