// UI stub for GitHub clone flow. No backend — static mock data only.
// Real list/clone calls will replace filterMockRepos/useMockRepos later.

export interface MockRepo {
  id: string
  name: string
  fullName: string
  description: string
  language: string
  stars: number
  isPrivate: boolean
  updatedAt: string
}

export const MOCK_REPOS: MockRepo[] = [
  {
    id: "1",
    name: "devbox",
    fullName: "web2bizz/devbox",
    description: "React Native / Expo client for the DevBox AI coding agent",
    language: "TypeScript",
    stars: 128,
    isPrivate: false,
    updatedAt: "2 hours ago",
  },
  {
    id: "2",
    name: "dotfiles",
    fullName: "dzianisv/dotfiles",
    description: "Personal dev environment: nvim, tmux, shell",
    language: "Shell",
    stars: 12,
    isPrivate: false,
    updatedAt: "3 days ago",
  },
  {
    id: "3",
    name: "api-gateway",
    fullName: "acme/api-gateway",
    description: "Internal edge gateway, auth + rate limiting",
    language: "Go",
    stars: 45,
    isPrivate: true,
    updatedAt: "yesterday",
  },
  {
    id: "4",
    name: "landing",
    fullName: "acme/landing",
    description: "Marketing site, Next.js + Tailwind",
    language: "TypeScript",
    stars: 8,
    isPrivate: false,
    updatedAt: "5 days ago",
  },
  {
    id: "5",
    name: "ml-pipeline",
    fullName: "acme/ml-pipeline",
    description: "Training + eval pipelines for reranker",
    language: "Python",
    stars: 63,
    isPrivate: true,
    updatedAt: "last week",
  },
  {
    id: "6",
    name: "notes",
    fullName: "dzianisv/notes",
    description: "Personal knowledge base",
    language: "Markdown",
    stars: 3,
    isPrivate: true,
    updatedAt: "2 weeks ago",
  },
  {
    id: "7",
    name: "devbox-core",
    fullName: "web2bizz/devbox-core",
    description: "The AI coding agent engine powering DevBox",
    language: "TypeScript",
    stars: 24100,
    isPrivate: false,
    updatedAt: "1 hour ago",
  },
  {
    id: "8",
    name: "hello-world",
    fullName: "dzianisv/hello-world",
    description: "My first repository",
    language: "Python",
    stars: 0,
    isPrivate: false,
    updatedAt: "last month",
  },
]

export function filterMockRepos(query: string): MockRepo[] {
  const q = query.trim().toLowerCase()
  if (!q) return MOCK_REPOS
  return MOCK_REPOS.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.fullName.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q),
  )
}
