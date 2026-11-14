import { Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import {
  DEFAULT_AGENT_ID,
  type AgentDefinition,
} from './agents-registry.types';

/**
 * AgentsRegistryService — single resolve/select/list source over the executor
 * definitions (ask/auto visible, backend/frontend/fullstack hidden executors).
 *
 * Dependency-free by design (mirrors ToolRegistryService): the executors
 * register their definitions through AgentsBootstrapService in the sibling
 * `agents` module, so this module never imports the executors layer and no
 * agents↔agents-registry cycle exists.
 *
 * `resolve` never throws: an unknown id falls back to the default agent, so a
 * stale client pick cannot turn a chat turn into a 500. `list` is the only
 * picker surface (hidden + subagent rows are filtered out).
 */
@Injectable()
export class AgentsRegistryService {
  private readonly logger: AppLogger = new AppLogger(AgentsRegistryService.name);
  private readonly definitions: Map<string, AgentDefinition> = new Map<
    string,
    AgentDefinition
  >();

  register(definition: AgentDefinition): void {
    if (this.definitions.has(definition.id)) {
      this.logger.warn(`[agents] duplicate registration id=${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
  }

  registerAll(definitions: ReadonlyArray<AgentDefinition>): void {
    for (const definition of definitions) this.register(definition);
  }

  /** Resolve one id (unknown/absent → default ask); never throws. */
  resolve(agentId?: string): AgentDefinition {
    const fallback: AgentDefinition | undefined = this.definitions.get(DEFAULT_AGENT_ID);
    if (!fallback) throw new Error('default agent is not registered');
    if (!agentId) return fallback;
    const found: AgentDefinition | undefined = this.definitions.get(agentId);
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

  /** Every registered id in registration order. */
  names(): Array<string> {
    return Array.from(this.definitions.keys());
  }
}

/**
 * Backwards-compatible value alias of the registry service (same class
 * object, same DI token): existing `AgentRegistry` importers keep working
 * while new code imports `AgentsRegistryService` from this module.
 */
export const AgentRegistry: typeof AgentsRegistryService = AgentsRegistryService;
