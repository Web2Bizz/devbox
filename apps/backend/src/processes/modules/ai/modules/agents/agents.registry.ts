/**
 * Backwards-compatibility shim: the registry lives in the sibling
 * `agents-registry` module now (mirrors the tools/tool-registry split).
 * New code imports from `../agents-registry/agents-registry.service` and
 * `../agents-registry/agents-registry.types` directly; this file only
 * re-exports so existing importers keep working.
 */
export {
  AgentRegistry,
  AgentsRegistryService,
} from '../agents-registry/agents-registry.service';
export {
  DEFAULT_AGENT_ID,
  type AgentDefinition,
  type AgentMode,
} from '../agents-registry/agents-registry.types';
