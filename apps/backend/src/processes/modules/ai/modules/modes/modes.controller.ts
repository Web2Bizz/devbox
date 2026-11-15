import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../../auth/jwt-auth.guard';
import { ModesService } from './modes.service';
import { ModeDto } from './modes.dto';
import type { ModeEntry } from './modes.types';

/**
 * ModesController — owns only the modes routes (CoC backend §1.1).
 * The sibling agents controller never serves mode routes.
 */
@ApiTags('agents-modes')
@ApiBearerAuth()
@Controller('agents/modes')
@UseGuards(JwtAuthGuard)
export class ModesController {
  constructor(private readonly modes: ModesService) {}

  @Get()
  @ApiOperation({ summary: 'List available agent work modes' })
  @ApiResponse({ status: 200, type: [ModeDto] })
  list(): Array<ModeDto> {
    const entries: Array<ModeEntry> = this.modes.listModes();
    const dtos: Array<ModeDto> = entries.map((entry) => ({
      mode: entry.mode,
      workflow: entry.workflow,
      description: entry.description,
    }));
    return dtos;
  }
}
