// Pure shaping of the catalog server responses (agents / commands /
// providers), extracted from the catalog store so it is unit-testable under
// plain `node --test` and reusable by both the React Query fetcher and the
// Zustand selection store. Selection defaults (which agent/model is active)
// stay in the store — they depend on the user's previous choice, not just the
// server payload (see chooseModelSelection).
import type { Agent, Command } from "./sdk"

export interface ProviderModel {
  id: string
  name: string
  reasoning: boolean
  attachment: boolean
  limit?: { context: number; output: number }
  variants?: Record<string, { reasoningEffort?: string }>
}

export interface Provider {
  id: string
  name: string
  connected: boolean
  models: ProviderModel[]
}

// Raw GET /provider payload: { all: [...], default: {...}, connected: [...] }.
// Typed loosely — older servers may omit fields, and every fetch site already
// tolerates nulls (see the queryFn in src/queries/catalog.ts).
export interface RawProviderList {
  all?: unknown
  default?: Record<string, string>
  connected?: unknown
}

export interface ParsedCatalog {
  agents: Agent[]
  commands: Command[]
  providers: Provider[]
  defaults: Record<string, string>
}

export function parseCatalogResponse(
  agentResult: unknown,
  commandResult: unknown,
  providerResult: RawProviderList | null | undefined,
): ParsedCatalog {
  const agents = Array.isArray(agentResult) ? (agentResult as Agent[]) : []
  const commands = Array.isArray(commandResult) ? (commandResult as Command[]) : []

  // Parse provider response: { all: [...], default: {...}, connected: [...] }
  const raw = providerResult
  const connected = new Set(Array.isArray(raw?.connected) ? (raw.connected as unknown[]) : [])
  const defaults = raw?.default || {}
  const providers: Provider[] = Array.isArray(raw?.all)
    ? (raw.all as Array<Record<string, any>>)
        .filter((p) => connected.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.name || p.id,
          connected: connected.has(p.id),
          models: Object.values((p.models || {}) as Record<string, any>)
            .filter((m) => m.status !== "deprecated")
            .map((m) => ({
              id: m.id,
              name: m.name || m.id,
              reasoning: m.reasoning ?? false,
              attachment: m.attachment ?? false,
              limit: m.limit,
              variants: m.variants,
            })),
        }))
        .filter((p) => p.models.length > 0)
    : []

  // Filter out hidden agents
  const visible = agents.filter((a) => !a.hidden)

  return { agents: visible, commands, providers, defaults }
}
