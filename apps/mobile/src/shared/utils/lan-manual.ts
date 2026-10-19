// Manual LAN entry: turn a hand-typed ip:port into a full server URL.
// Pure — unit-testable with node --test. The component (app/connection/add)
// keeps a thin wrapper around this so there is exactly one implementation.
export function buildManualLanUrl(ip: string, port: string): string | null {
  const host = (ip ?? "").trim()
  if (!host) return null
  const p = (port ?? "").trim() || "4096"
  if (!/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535) return null
  const m = host.match(/^(https?:\/\/)/i)
  const scheme = m ? m[1].toLowerCase() : "http://"
  const cleanHost = host.replace(/^https?:\/\//i, "").replace(/\/+$/, "")
  if (!cleanHost || cleanHost.includes(" ")) return null
  return `${scheme}${cleanHost}:${p}`
}
