import { create } from "zustand"
import * as SecureStore from "expo-secure-store"
import * as Crypto from "expo-crypto"
import type { ServerConnection, ConnectionType } from "../lib/types"
import { createClient, type Client } from "../lib/sdk"
import { buildAuth } from "../lib/auth"
import { stripTrailingSlash } from "@web2bizz/ui-native"
import { HARDCODED_SERVER_URL } from "../lib/server-config"
import { invalidateConnectionScopeQueries } from "../lib/query-invalidate"
import { useEvents } from "./events"

const CONNECTIONS_KEY = "opencode_connections"
const PASSWORDS_PREFIX = "opencode_password_"
const RECENT_DIRS_KEY = "opencode_recent_dirs"
const MAX_RECENT_DIRS = 10
// A bad IP (unreachable host, wrong port) otherwise hangs for the full 30s
// general request timeout before the user sees a "connection failed" error —
// a first-run bounce driver. The interactive connect flow can afford to fail
// faster since a real server responds to /global/health in well under a
// second; this does NOT affect the timeout used for real session traffic.
const CONNECTION_TEST_TIMEOUT_MS = 12_000

// Cached auth so we can create directory-scoped clients without async SecureStore lookups
interface ClientBase {
  baseUrl: string
  auth?: { username: string; password: string }
}interface ConnectionsState {
  connections: ServerConnection[]
  activeConnection: ServerConnection | null
  client: Client | null
  clientBase: ClientBase | null
  // NOTE: no currentProject/serverHome here by design — project info is a
  // React Query snapshot (useProjectInfo()), invalidated on every change
  // below. Mirroring it in Zustand was a second source of truth.
  //
  // Multi-server: one entry per connection so ANY server's data can be
  // fetched with its own credentials (unified cloud+LAN lists, per-origin
  // action routing, parallel SSE streams). `client`/`clientBase` above stay
  // as the ACTIVE aliases. A base with `auth` set means stored credentials
  // exist for that connection; bases without auth are skipped by reads and
  // streams until the user saves credentials.
  clientBases: Record<string, ClientBase>
  recentDirectories: string[]
  isLoading: boolean
  error: string | null

  // Actions
  loadConnections: () => Promise<void>
  addConnection: (connection: Omit<ServerConnection, "id">, password?: string) => Promise<void>
  // Second-connection path for LAN discovery: same storage, but the entry
  // keeps its discovered URL (hardcode enforcement skips LAN-marked entries)
  // and starts inactive — the caller activates it explicitly. Returns the id.
  addLanConnection: (url: string, name?: string) => Promise<string>
  removeConnection: (id: string) => Promise<void>
  // Full logout: drop EVERY connection (cloud + LAN) with their stored
  // passwords, so the auth gate lands (and stays) on the login entry
  // choice. Removing only the active entry is not enough with two
  // connections — the remaining one is still valid and the gate would bounce
  // straight back into the app instead of showing login.
  logoutAll: () => Promise<void>
  setActiveConnection: (id: string) => Promise<void>
  testConnection: (
    connection: ServerConnection,
    password?: string,
  ) => Promise<{ ok: boolean; error?: string }>
  updateConnection: (id: string, updates: Partial<ServerConnection>, password?: string) => Promise<void>
  // Create a one-off client pointing at a specific directory (for cross-project operations).
  // Pass undefined to get a directory-less client that queries the server without project scope.
  // With connectionId, the client targets THAT connection (any server, any
  // credentials); without it, the active connection (legacy behavior).
  clientForDirectory: (directory?: string, connectionId?: string) => Client | null
  // Directory-less client for a connection by id (reads, SSE streams).
  // Null when the connection is unknown (removed) — callers treat that as
  // "skip this server". NOTE: the client carries whatever auth is cached;
  // servers without stored credentials 401, and callers handle that.
  clientForConnection: (connectionId: string) => Client | null
  // Switch the active connection's directory and reload
  switchDirectory: (directory?: string) => Promise<void>
  // Record a directory as recently used
  addRecentDirectory: (directory: string) => Promise<void>
}

function generateId(): string {
  return Crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

function buildClient(
  url: string,
  directory?: string,
  auth?: { username: string; password: string },
): { client: Client; base: ClientBase } {
  const base: ClientBase = { baseUrl: url, auth }
  const client = createClient({ baseUrl: url, directory, auth })
  return { client, base }
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  connections: [],
  activeConnection: null,
  client: null,
  clientBase: null,
  clientBases: {},
  recentDirectories: [],
  isLoading: true,
  error: null,

  loadConnections: async () => {
    try {
      set({ isLoading: true, error: null })
      const [stored, recentRaw] = await Promise.all([
        SecureStore.getItemAsync(CONNECTIONS_KEY),
        SecureStore.getItemAsync(RECENT_DIRS_KEY),
      ])
      let connections: ServerConnection[] = stored ? JSON.parse(stored) : []
      const recentDirectories: string[] = recentRaw ? JSON.parse(recentRaw) : []
      // Enforce hardcoded URL — migrate any existing connections, but NEVER
      // touch LAN-discovered entries: their custom URL is the whole point.
      let migrated = false
      connections = connections.map((c) => {
        if (!c.discoveredOnLan && c.url !== HARDCODED_SERVER_URL) {
          migrated = true
          return { ...c, url: HARDCODED_SERVER_URL }
        }
        return c
      })
      if (migrated) {
        await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
      }

      // Clean up auto-created empty connection from previous hardcode migration
      // (it had no credentials and immediately caused authError before user
      // ever saw the login form). Remove it so first launch shows clean login
      // without "Ошибка авторизации".
      if (
        connections.length === 1 &&
        connections[0].name === "Основной сервер" &&
        !connections[0].username
      ) {
        const staleId = connections[0].id
        await SecureStore.deleteItemAsync(`${PASSWORDS_PREFIX}${staleId}`)
        connections = []
        await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
      }

      // Find active connection
      const active = connections.find((c) => c.active) || null

      // Create clients for the active connection
      let client: Client | null = null
      let base: ClientBase | null = null
      // Bases for EVERY connection (passwords are read for all, not just the
      // active one) so background reads/streams can target any server.
      const clientBases: Record<string, ClientBase> = {}
      if (connections.length > 0) {
        const passwords = await Promise.all(
          connections.map((c) => SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${c.id}`)),
        )
        connections.forEach((c, i) => {
          const auth = buildAuth(c.username, passwords[i])
          clientBases[c.id] = { baseUrl: c.url, auth }
        })
      }
      if (active) {
        const built = buildClient(active.url, active.directory, clientBases[active.id].auth)
        client = built.client
        base = built.base
        // Project info is NOT prefetched here — useProjectInfo() fetches it
        // through the query cache as soon as a screen mounts.
      }

      set({
        connections,
        activeConnection: active,
        client,
        clientBase: base,
        clientBases,
        recentDirectories,
        isLoading: false,
      })
    } catch (error) {
      set({ error: "Failed to load connections", isLoading: false })
    }
  },

  addConnection: async (connection, password) => {
    const id = generateId()
    // Enforce hardcoded URL — except for LAN-discovered entries, which keep
    // their scanned URL (the marker is set by the discovery flow only).
    const hardcodedConnection = connection.discoveredOnLan
      ? { ...connection }
      : { ...connection, url: HARDCODED_SERVER_URL }
    const newConnection: ServerConnection = {
      ...hardcodedConnection,
      id,
      active: get().connections.length === 0, // First connection is active
    }

    const connections = [...get().connections, newConnection]

    // Store password separately if provided
    if (password) {
      await SecureStore.setItemAsync(`${PASSWORDS_PREFIX}${id}`, password)
    }

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    // If this is the first/active connection, create client
    let client = get().client
    let base = get().clientBase
    let activeConnection = get().activeConnection

    if (newConnection.active) {
      activeConnection = newConnection
      const auth = buildAuth(newConnection.username, password)
      const built = buildClient(newConnection.url, newConnection.directory, auth)
      client = built.client
      base = built.base
    }

    set({
      connections,
      activeConnection,
      client,
      clientBase: base,
      clientBases: { ...get().clientBases, [id]: { baseUrl: hardcodedConnection.url, auth: buildAuth(hardcodedConnection.username, password) } },
    })
    // New client identity — cached snapshots belong to the previous one.
    if (newConnection.active) invalidateConnectionScopeQueries()
  },

  addLanConnection: async (url, name) => {
    const id = generateId()
    const entry: ServerConnection = {
      id,
      name: name || url,
      type: "local",
      url,
      discoveredOnLan: true,
      active: false,
    }
    const connections = [...get().connections, entry]
    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
    // No credentials yet — base without auth; reads/streams skip this server
    // until the user saves credentials (edit screen), which rebuilds it.
    set({ connections, clientBases: { ...get().clientBases, [id]: { baseUrl: url } } })
    return id
  },

  removeConnection: async (id) => {
    const connections = get().connections.filter((c) => c.id !== id)

    // Remove stored password
    await SecureStore.deleteItemAsync(`${PASSWORDS_PREFIX}${id}`)
    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
    // Stop that server's SSE stream (its sessions leave the merged snapshot
    // via the invalidation below; prune clears their statuses).
    useEvents.getState().dropConnectionStream(id)

    // If removing active connection, clear client
    const wasActive = get().activeConnection?.id === id
    const clientBases = { ...get().clientBases }
    delete clientBases[id]
    if (wasActive) {
      const newActive = connections[0] || null
      if (newActive) {
        // Mark new connection as active
        newActive.active = true
        await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
        const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${newActive.id}`)
        const auth = buildAuth(newActive.username, password)
        const built = buildClient(newActive.url, newActive.directory, auth)
        set({ connections, activeConnection: newActive, client: built.client, clientBase: built.base, clientBases })
      } else {
        set({ connections, activeConnection: null, client: null, clientBase: null, clientBases })
      }
      invalidateConnectionScopeQueries()
    } else {
      set({ connections, clientBases })
    }
  },

  setActiveConnection: async (id) => {
    const connections = get().connections.map((c) => ({
      ...c,
      active: c.id === id,
    }))

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    const active = connections.find((c) => c.id === id) || null
    let client: Client | null = null
    let base: ClientBase | null = null

    if (active) {
      const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${active.id}`)
      const auth = buildAuth(active.username, password)
      const built = buildClient(active.url, active.directory, auth)
      client = built.client
      base = built.base

      // Update last connected time
      active.lastConnected = Date.now()
      await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
    }

    const clientBases = { ...get().clientBases }
    if (active && base) clientBases[active.id] = base
    set({ connections, activeConnection: active, client, clientBase: base, clientBases })
    invalidateConnectionScopeQueries()
  },

  logoutAll: async () => {
    // Sequential: each removeConnection re-reads state and persists, so the
    // last removal lands on fully cleared client/credentials.
    for (const id of get().connections.map((c) => c.id)) {
      await get().removeConnection(id)
    }
  },

  testConnection: async (connection, password) => {
    try {
      const client = createClient({
        // Honor the entry's own URL — LAN-discovered connections live on
        // their scanned address; pinning hardcoded here made LAN login
        // (and LAN re-tests) authenticate against the wrong server.
        baseUrl: connection.url,
        directory: connection.directory,
        auth: buildAuth(connection.username, password),
      })

      await client.global.health(CONNECTION_TEST_TIMEOUT_MS)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  },

  updateConnection: async (id, updates, password) => {
    const existing = get().connections.find((c) => c.id === id)
    // Enforce hardcoded URL — ignore any URL change from UI. LAN-discovered
    // entries are exempt: their custom URL is user-confirmed via discovery.
    const sanitizedUpdates =
      existing?.discoveredOnLan && updates.url ? { ...updates } : { ...updates, url: HARDCODED_SERVER_URL }
    const connections = get().connections.map((c) => (c.id === id ? { ...c, ...sanitizedUpdates } : c))

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    // Persist a new password only when one was entered. The edit form loads the
    // password field blank (passwords aren't read back for security), so an
    // empty value means "keep the existing password", not "clear it". Written
    // before the active-client rebuild below so the rebuilt client picks it up.
    if (password) {
      await SecureStore.setItemAsync(`${PASSWORDS_PREFIX}${id}`, password)
    }

    // If updating active connection, recreate client
    if (get().activeConnection?.id === id) {
      const active = connections.find((c) => c.id === id)!
      const storedPassword = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${id}`)
      const auth = buildAuth(active.username, storedPassword)
      const built = buildClient(active.url, active.directory, auth)
      set({
        connections,
        activeConnection: active,
        client: built.client,
        clientBase: built.base,
      })
    } else {
      set({ connections })
    }
    // Refresh the cached base for the edited entry (any server — this is how
    // an inactive LAN entry picks up freshly saved credentials) and drop
    // stale snapshots; mounted hooks refetch. Covers switchDirectory too.
    const edited = connections.find((c) => c.id === id)
    if (edited) {
      const storedPassword = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${id}`)
      set({
        clientBases: {
          ...get().clientBases,
          [id]: { baseUrl: edited.url, auth: buildAuth(edited.username, storedPassword) },
        },
      })
    }
    invalidateConnectionScopeQueries()
  },

  clientForDirectory: (directory, connectionId) => {
    const st = get()
    // Origin-aware: an explicit connectionId NEVER falls back to the active
    // server — a wrong-server request is worse than an explicit null (which
    // surfaces the "no connection" error instead of corrupting data).
    if (connectionId) {
      const base = st.clientBases[connectionId]
      if (!base) return null
      return createClient({ baseUrl: base.baseUrl, directory, auth: base.auth })
    }
    const base = st.clientBase
    if (!base) return null
    // Reuse current client if directory matches (active scope only)
    const active = st.activeConnection
    if (active?.directory === directory) return st.client
    return createClient({ baseUrl: base.baseUrl, directory, auth: base.auth })
  },

  clientForConnection: (connectionId) => {
    const base = get().clientBases[connectionId]
    if (!base) return null
    return createClient({ baseUrl: base.baseUrl, directory: undefined, auth: base.auth })
  },

  switchDirectory: async (directory) => {
    const active = get().activeConnection
    if (!active) return
    // Update connection directory and recreate client. Normalize trailing
    // slashes so "/home/user" and "/home/user/" don't diverge (recent-dir
    // duplicates + a mismatched "current directory" highlight).
    const trimmed = directory?.trim()
    const dir = trimmed ? stripTrailingSlash(trimmed) : undefined
    await get().updateConnection(active.id, { directory: dir })
    // Record in recents if it's a real directory
    if (dir) await get().addRecentDirectory(dir)
  },

  addRecentDirectory: async (directory) => {
    const current = get().recentDirectories
    // Normalize trailing slashes so the same dir entered as ".../x" and
    // ".../x/" dedups to one recent-list entry instead of two.
    directory = stripTrailingSlash(directory.trim())
    // Move to front, dedup, cap at MAX
    const updated = [directory, ...current.filter((d) => d !== directory)].slice(0, MAX_RECENT_DIRS)
    set({ recentDirectories: updated })
    await SecureStore.setItemAsync(RECENT_DIRS_KEY, JSON.stringify(updated))
  },
}))
