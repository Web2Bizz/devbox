import { Injectable, NotFoundException } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import type { ModeEntry, ModeSelection } from './modes.types';

/**
 * ModesService — MODES layer (selector, not executors): maps the requested
 * agent id to its work mode and workflow. 'ask' mode → 'single-answer'
 * workflow (one direct answer, AskAgent); 'auto' mode → 'routed-chain'
 * workflow (Jev-routed domain chain, AutoAgent). Unknown ids throw the honest
 * 404 AT THE SITE (same message the agents facade used before the split).
 */
@Injectable()
export class ModesService {
  constructor(private readonly logger: AppLogger = new AppLogger(ModesService.name)) {}

  /** Resolves one agent id to its mode + workflow (throws honest 404 when unknown). */
  resolve(agentId: string, correlationId?: string): ModeSelection {
    if (agentId === 'ask') {
      const selection: ModeSelection = { mode: 'ask', workflow: 'single-answer' };
      this.logger.info(
        `[modes] resolve mode=${selection.mode} workflow=${selection.workflow}`,
        correlationId,
      );
      return selection;
    }
    if (agentId === 'auto') {
      const selection: ModeSelection = { mode: 'auto', workflow: 'routed-chain' };
      this.logger.info(
        `[modes] resolve mode=${selection.mode} workflow=${selection.workflow}`,
        correlationId,
      );
      return selection;
    }
    throw new NotFoundException(`Agent '${agentId}' not found`);
  }

  /** Picker list of the available modes (fixed pair, definitions only). */
  listModes(): Array<ModeEntry> {
    const modes: Array<ModeEntry> = [
      {
        mode: 'ask',
        workflow: 'single-answer',
        description: 'Single-answer mode: one direct answer, no steps',
      },
      {
        mode: 'auto',
        workflow: 'routed-chain',
        description: 'Router mode: classifies the request and runs a domain workflow',
      },
    ];
    return modes;
  }
}
