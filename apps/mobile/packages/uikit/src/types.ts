/**
 * Minimal chat-domain types.
 *
 * Mirrors `src/lib/sdk.ts` (`Message`, `Part`) field-for-field so values
 * flowing from the app store stay structurally assignable, but lives inside
 * the package so uikit components never import `../../lib/*` (which does not
 * exist in the package). New code in this package should import these types
 * directly.
 */

export interface Message {
  id: string
  sessionID: string
  role: "user" | "assistant"
  parentID?: string
  time: {
    created: number
    completed?: number
  }
  // User message fields
  agent?: string
  model?: { providerID: string; modelID: string }
  // Assistant message fields
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning?: number
    cache?: { read: number; write: number }
  }
  error?: { message: string }
  finish?: string
}

export interface Part {
  id: string
  sessionID?: string
  messageID: string
  type:
    | "text"
    | "reasoning"
    | "tool"
    | "file"
    | "snapshot"
    | "patch"
    | "step-start"
    | "step-finish"
    | "subtask"
    | "retry"
    | "compaction"
    | "agent"
  // Text / reasoning part
  text?: string
  // Tool part
  tool?: string
  callID?: string
  state?: {
    status: "pending" | "running" | "completed" | "error"
    input?: unknown
    output?: unknown
    title?: string
    error?: { message: string }
    time?: { start?: number; end?: number }
  }
  // Timing
  time?: { start?: number; end?: number }
  // File part
  mime?: string
  url?: string
  filename?: string
}

// --- Session + catalog domain (mirrors src/lib/sdk.ts + src/lib/catalog-parse.ts
// field-for-field for the fields UI components read; same rationale as
// Message/Part above: values from the app store stay structurally
// assignable, but uikit components never import ../../lib/*).

export interface SessionSummary {
  additions: number
  deletions: number
  files: number
}

export interface Session {
  id: string
  title: string
  summary?: SessionSummary
  share?: { url: string }
  time: {
    created: number
    updated: number
  }
}

export interface ProviderModel {
  id: string
  limit?: { context: number; output: number }
}

export interface Provider {
  id: string
  models: ProviderModel[]
}

// --- Filesystem domain (mirrors src/lib/sdk.ts FileEntry and the FileRoot
// shape for the fields the directory explorer reads).

export interface FileEntry {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

export interface FileRoot {
  path: string
  label: string
}

// Minimal structural client for the directory explorer: only the calls
// DirectoryBrowserSheet makes. The app's full Client stays assignable.
export interface DirectoryClient {
  file: {
    list: (params: { path?: string }) => Promise<FileEntry[]>
    roots: () => Promise<FileRoot[] | null>
  }
  path: {
    get: () => Promise<{ home: string }>
  }
}
