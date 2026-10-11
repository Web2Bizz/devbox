import { create } from "zustand"
import type { MockRepo } from "../lib/github-mock"

// UI-only stub. Backend will later replace addCloned() with a real
// clone call; the shape { id, name, fullName, path } is kept stable
// so screens don't need to change when the backend lands.
export interface ClonedProject {
  id: string
  name: string
  fullName: string
  path: string
  clonedAt: number
}

interface ClonedProjectsState {
  projects: ClonedProject[]
  addCloned: (repo: MockRepo, baseDir?: string) => ClonedProject
  clear: () => void
}

export const useClonedProjects = create<ClonedProjectsState>((set) => ({
  projects: [],

  addCloned: (repo, baseDir) => {
    const base = baseDir?.trim() ? baseDir.replace(/\/+$/, "") : "~/projects"
    const project: ClonedProject = {
      id: repo.id,
      name: repo.name,
      fullName: repo.fullName,
      path: `${base}/${repo.name}`,
      clonedAt: Date.now(),
    }
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id)
        ? s.projects
        : [project, ...s.projects],
    }))
    return project
  },

  clear: () => set({ projects: [] }),
}))
