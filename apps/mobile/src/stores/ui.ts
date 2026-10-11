import { create } from "zustand"

interface UiState {
  showNewProject: boolean
  openNewProject: () => void
  closeNewProject: () => void
}

export const useUi = create<UiState>((set) => ({
  showNewProject: false,
  openNewProject: () => set({ showNewProject: true }),
  closeNewProject: () => set({ showNewProject: false }),
}))
