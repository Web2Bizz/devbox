// Central TanStack Query key factory — the single place that defines how
// server snapshots are cached. Every useQuery/fetchQuery/invalidate in the
// app must build its key from here so invalidation always hits the right
// entries (e.g. mutating a session invalidates exactly the session keys).
//
// Key layout: ["sessions", ...] groups everything session-scoped so a
// connection switch can drop the whole subtree with one prefix invalidate;
// global catalog/project keys stand alone.
export const queryKeys = {
  sessionsList: ["sessions", "list"] as const,
  sessionDetail: (sessionID: string) => ["sessions", "detail", sessionID] as const,
  sessionMessages: (sessionID: string) => ["sessions", "messages", sessionID] as const,
  sessionPending: (sessionID: string) => ["sessions", "pending", sessionID] as const,
  catalog: ["catalog"] as const,
  projectInfo: ["project", "info"] as const,
  serverProjects: ["project", "list"] as const,
  // Per-connection server-project list: one cache entry per server so a LAN
  // server's projects never collide with (or reuse) the cloud snapshot.
  // Prefix-invalidation on `serverProjects` still hits every entry below.
  serverProjectsFor: (connectionId: string) => ["project", "list", connectionId] as const,
  // Git remotes parsed from the project's .git/config: one cache entry per
  // (server, directory). Prefix-invalidation on `projectRemotes` hits all.
  projectRemotes: ["project", "remotes"] as const,
  projectRemotesFor: (connectionId: string, directory: string) =>
    ["project", "remotes", connectionId, directory] as const,
} as const

// Prefix that matches every session-scoped key (list, detail, messages,
// pending) — used when the connection identity changes and no cached
// snapshot can be trusted anymore.
export const sessionsScopePrefix = ["sessions"] as const
