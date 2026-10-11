// LAN discovery for self-hosted opencode servers: subnet sweep (path 1).
//
// Runs ONLY when the user enables it (settings.lanDiscovery, default off) —
// never at launch, never in the background. The hardcoded main server stays
// the default; a discovered host becomes a SECOND connection entry (marked
// discoveredOnLan) that lives alongside it in the existing connections list.
//
// Pure + dependency-injected: platform I/O (own IP via expo-network, fetch)
// enters through parameters, so the whole sweep is unit-testable under plain
// `node --test` without sockets.

export interface LanCandidate {
  url: string // e.g. http://192.168.1.23:4096
  host: string
  port: number
  version?: string // from /global/health when the server reports one
  // 401/403 means the server is reachable but needs login — still a hit
  // (same rule the ConnectionBadge ping uses).
  authRequired: boolean
}

// opencode `serve` default port. Kept as a list so more candidates can be
// added without touching the sweep logic.
export const DEFAULT_LAN_PORTS = [4096] as const
export const LAN_PROBE_TIMEOUT_MS = 1500
export const LAN_SCAN_CONCURRENCY = 32

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.trim().split(".")
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255 || parts.some((p) => p === ""))) return null
  // Reject leading-zero octets ("01") — ambiguous, and iOS/Android IP stacks
  // never produce them, so anything shaped like that isn't a real local IP.
  if (parts.some((p) => p.length > 1 && p.startsWith("0"))) return null
  return nums as [number, number, number, number]
}

/** True for RFC1918 addresses only — never scan off-LAN (or garbage). */
export function isPrivateLanIpv4(ip: string): boolean {
  const oct = parseIpv4(ip)
  if (!oct) return false
  const [a, b] = oct
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * All candidate hosts of the /24 containing `ipv4` (.1–.254, own address
 * excluded). Returns [] for non-private input — the caller shows "not on a
 * LAN" instead of sweeping the public internet.
 */
export function hostsInSubnet24(ipv4: string): string[] {
  if (!isPrivateLanIpv4(ipv4)) return []
  const [a, b, c, d] = parseIpv4(ipv4)!
  const hosts: string[] = []
  for (let last = 1; last <= 254; last++) {
    if (last === d) continue
    hosts.push(`${a}.${b}.${c}.${last}`)
  }
  return hosts
}

// Minimal fetch surface the probe needs — matches the real Response, so
// production passes global fetch and tests pass a stub.
export interface ProbeFetch {
  (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
  }>
}

export interface ProbeOptions {
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: ProbeFetch
}

/** Probe one host:port for an opencode server. Null = nothing there. */
export async function probeServer(
  host: string,
  port: number,
  { timeoutMs = LAN_PROBE_TIMEOUT_MS, signal, fetchImpl = fetch as unknown as ProbeFetch }: ProbeOptions = {},
): Promise<LanCandidate | null> {
  const url = `http://${host}:${port}`
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const onExternalAbort = () => timeout.abort()
  signal?.addEventListener("abort", onExternalAbort)
  try {
    if (signal?.aborted) return null
    const res = await fetchImpl(`${url}/global/health`, {
      headers: { Accept: "application/json" },
      signal: timeout.signal,
    })
    if (!res.ok && res.status !== 401 && res.status !== 403) return null
    let version: string | undefined
    if (res.ok) {
      try {
        const body = (await res.json()) as { version?: unknown }
        if (typeof body?.version === "string") version = body.version
      } catch {
        // Health answered but not JSON — still a server, just versionless.
      }
    }
    return { url, host, port, version, authRequired: !res.ok }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onExternalAbort)
  }
}

export interface ScanOptions extends ProbeOptions {
  concurrency?: number
  onCandidate?: (candidate: LanCandidate) => void
  onProgress?: (scanned: number, total: number) => void
}

/**
 * Sweep hosts for one port with a bounded worker pool. Candidates stream out
 * via onCandidate as they answer; the returned array is in discovery order.
 * Stops early when `signal` aborts (in-flight probes finish their timeout).
 */
export async function scanLanHosts(
  hosts: string[],
  port: number,
  {
    timeoutMs = LAN_PROBE_TIMEOUT_MS,
    concurrency = LAN_SCAN_CONCURRENCY,
    signal,
    fetchImpl,
    onCandidate,
    onProgress,
  }: ScanOptions = {},
): Promise<LanCandidate[]> {
  const found: LanCandidate[] = []
  let next = 0
  let scanned = 0
  const total = hosts.length
  const workers = Math.max(1, Math.min(concurrency, Math.max(total, 1)))

  const worker = async () => {
    while (next < hosts.length) {
      if (signal?.aborted) return
      const host = hosts[next++]
      const hit = await probeServer(host, port, { timeoutMs, signal, fetchImpl })
      scanned++
      onProgress?.(scanned, total)
      if (hit) {
        found.push(hit)
        onCandidate?.(hit)
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()))
  return found
}
