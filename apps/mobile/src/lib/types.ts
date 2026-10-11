// Connection types for multiple server support
export type ConnectionType = "local" | "tunnel" | "cloud"

export interface ServerConnection {
  id: string
  name: string
  type: ConnectionType
  url: string
  // For auth
  username?: string
  // Password stored separately in SecureStore
  // Directory to use for this connection
  directory?: string
  // When last successfully connected
  lastConnected?: number
  // Is this the active connection?
  active?: boolean
  // Set for servers found by LAN discovery (opt-in setting). The hardcoded
  // main server stays the default; a LAN entry lives ALONGSIDE it as a
  // second connection and keeps its own URL — the hardcode enforcement in
  // the connections store skips marked entries.
  discoveredOnLan?: boolean
}

export interface AppSettings {
  // Require biometric auth to open app
  requireBiometric: boolean
  // Require biometric to send messages
  requireBiometricForMessages: boolean
  // Theme preference
  theme: "light" | "dark" | "system"
  // Show notifications for task completion
  notifications: boolean
}

// Re-export SDK types we'll use frequently
export type { Session, Message, Part, Project, Event, HealthResponse } from "./sdk"
