import { create } from "zustand"
import type { Agent } from "../lib/sdk"
import { chooseModelSelection } from "../lib/model-selection"
import { type ParsedCatalog, type Provider, type ProviderModel } from "../lib/catalog-parse"

// Re-exported so existing `import type { Provider } from "../stores/catalog"`
// call sites (SessionInfo) keep working.
export type { Provider, ProviderModel }

interface ModelSelection {
  providerID: string
  modelID: string
}

function sameModel(left: ModelSelection | null, right: ModelSelection | null) {
  return left?.providerID === right?.providerID && left?.modelID === right?.modelID
}

// The catalog store owns SELECTIONS only (active agent/model/variant — pure
// client state). The server LISTS come from React Query (useCatalogData() in
// src/queries/catalog.ts) and are pushed in here via reseed(), which preserves
// a still-valid user choice and otherwise falls back to connected defaults.
// The old fetch-everything load() is gone: screens read lists straight from
// the query cache, so the store never holds a second copy of server data.
interface CatalogState {
  // Current selections
  agent: string // agent name, e.g. "build"
  model: ModelSelection | null
  variant: string | null // model variant for reasoning effort (e.g. "low", "medium", "high")

  // Actions
  // Seed/refresh selections from a fresh snapshot: keep the current choice
  // when it is still valid, otherwise pick connected defaults. Idempotent —
  // safe to call on every query emission.
  reseed: (data: ParsedCatalog) => void
  setAgent: (name: string, agents: Agent[]) => void
  setModel: (selection: ModelSelection | null) => void
  setVariant: (variant: string | null) => void
  cycleAgent: (agents: Agent[], direction?: 1 | -1) => void
}

export const useCatalog = create<CatalogState>((set, get) => ({
  agent: "",
  model: null,
  variant: null,

  reseed: (data) => {
    const { agents, providers, defaults } = data
    const current = get().agent
    const agent = current && agents.some((a) => a.name === current) ? current : agents[0]?.name || "build"

    // Default model: keep valid existing selection; otherwise prefer connected
    // provider defaults, then first connected model; agent model is last fallback.
    const existing = get().model
    const defaultAgent = agents[0]
    const model = chooseModelSelection({
      providers,
      defaults,
      existing,
      agentModel: defaultAgent?.model || null,
    })

    set((state) => ({
      agent,
      model,
      variant: sameModel(state.model, model) ? state.variant : null,
    }))
  },

  setAgent: (name, agents) => {
    const match = agents.find((a) => a.name === name)
    if (!match) return
    const model = match.model || get().model
    set((state) => ({
      agent: name,
      model,
      variant: sameModel(state.model, model) ? state.variant : null,
    }))
  },

  setModel: (selection) =>
    set((state) => ({
      model: selection,
      variant: sameModel(state.model, selection) ? state.variant : null,
    })),

  setVariant: (variant) => set({ variant }),

  cycleAgent: (agents, direction = 1) => {
    const { agent } = get()
    const primary = agents.filter((a) => a.mode === "primary" || a.mode === "all")
    if (primary.length < 2) return
    const idx = primary.findIndex((a) => a.name === agent)
    const next = (idx + direction + primary.length) % primary.length
    get().setAgent(primary[next].name, agents)
  },
}))
