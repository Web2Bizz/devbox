import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import { AskAgent } from './ask.agent';
import { AutoAgent } from './auto.agent';
import { BackendAgent } from './backend.agent';
import { FrontendAgent } from './frontend.agent';
import { FullstackAgent } from './fullstack.agent';

/** How an agent participates in a chat turn (primary picker vs subagent job). */
export type AgentMode = 'primary' | 'subagent';

/** Registry row of one agent (definitions only, no transport). */
export type AgentDefinition = {
  id: string;
  name: string;
  description: string;
  /** Hidden agents answer only through a parent agent / subagent job. */
  hidden: boolean;
  /** Subagent-mode rows are never offered by the chat picker. */
  mode: AgentMode;
};

/** Default agent when no id travels (the server's own default, not guessed). */
export const DEFAULT_AGENT_ID = 'ask';

/**
 * AgentRegistry — single resolve/select/list source over the existing agent
 * classes (ask/auto visible, backend/frontend/fullstack hidden executors).
 *
 * `resolve` never throws: an unknown id falls back to the default agent, so a
 * stale client pick cannot turn a chat turn into a 500. `list` is the only
 * picker surface (hidden + subagent rows are filtered out, as in the donor).
 */
@Injectable()
export class AgentRegistry {
  private readonly logger: AppLogger = new AppLogger(AgentRegistry.name);
  private readonly definitions = new Map<string, AgentDefinition>();

  constructor(
    private readonly ask: AskAgent,
    private readonly auto: AutoAgent,
    private readonly backend: BackendAgent,
    private readonly frontend: FrontendAgent,
    private readonly fullstack: FullstackAgent,
  ) {
    const rows: Array<{
      owner: { id: string; name: string; description: string };
      hidden: boolean;
      mode: AgentMode;
    }> = [
      { owner: this.ask, hidden: false, mode: 'primary' },
      { owner: this.auto, hidden: false, mode: 'primary' },
      { owner: this.backend, hidden: true, mode: 'subagent' },
      { owner: this.frontend, hidden: true, mode: 'subagent' },
      { owner: this.fullstack, hidden: true, mode: 'subagent' },
    ];
    for (const row of rows) {
      this.definitions.set(row.owner.id, {
        id: row.owner.id,
        name: row.owner.name,
        description: row.owner.description,
        hidden: row.hidden,
        mode: row.mode,
      });
    }
  }

  /** Resolve one id (unknown/absent → default ask); never throws. */
  resolve(agentId?: string): AgentDefinition {
    const fallback = this.definitions.get(DEFAULT_AGENT_ID);
    if (!fallback) throw new Error('default agent is not registered');
    if (!agentId) return fallback;
    const found = this.definitions.get(agentId);
    if (found) return found;
    this.logger.warn(`[agents] unknown agentId=${agentId} code=default_agent`);
    return fallback;
  }

  /** Alias with the donor's `select` name (same semantics as resolve). */
  select(agentId?: string): AgentDefinition {
    return this.resolve(agentId);
  }

  /** Picker list: visible primary agents only (hidden/subagent filtered). */
  list(): Array<AgentDefinition> {
    return Array.from(this.definitions.values()).filter(
      (agent) => !agent.hidden && agent.mode !== 'subagent',
    );
  }

  /** Every registered row (jobs/internal callers only, never the picker). */
  all(): Array<AgentDefinition> {
    return Array.from(this.definitions.values());
  }
}
