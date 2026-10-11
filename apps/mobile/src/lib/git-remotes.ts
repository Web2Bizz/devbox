// Git remote parsing for the project header card.
// Pure — no store/client imports, unit-testable with node --test.
//
// Remotes come from the server's `.git/config` (see useProjectRemotes),
// which stores URLs in either SSH or HTTPS form:
//   git@github.com:owner/repo.git
//   ssh://git@github.com/owner/repo.git
//   https://github.com/owner/repo.git
// The UI links out to the https web page, so every form is normalized here.

export interface GitRemote {
  name: string
  url: string
}

/** One remote with its tappable web URL, provider and display slug. */
export interface RepoLink extends GitRemote {
  webUrl: string
  provider: GitProvider
  /** "owner/repo" (or the full nested path for groups/subgroups). */
  slug: string
}

export type GitProvider = "github" | "gitlab" | "bitbucket" | "generic"

const REMOTE_SECTION_RE = /^\[\s*remote\s+"([^"]+)"\s*\]$/i

/**
 * Parse `[remote "<name>"]` sections out of a `.git/config` file.
 * Takes the first `url =` per section (the fetch URL, not pushurl);
 * branch/core sections and comments are ignored.
 */
export function parseGitConfigRemotes(configText: string): GitRemote[] {
  const out: GitRemote[] = []
  let current: string | null = null
  let url: string | null = null
  const flush = () => {
    if (current && url) out.push({ name: current, url })
    current = null
    url = null
  }
  for (const rawLine of (configText || "").split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const section = REMOTE_SECTION_RE.exec(line)
    if (section) {
      flush()
      current = section[1]
      continue
    }
    if (line.startsWith("[")) {
      flush()
      current = null
      continue
    }
    if (current && !url) {
      const m = /^url\s*=\s*(.+?)\s*$/.exec(line)
      if (m) url = m[1]
    }
  }
  flush()
  return out
}

function stripGitSuffix(path: string): string {
  return path.endsWith(".git") ? path.slice(0, -".git".length) : path
}

/**
 * Normalize any git remote URL to its https web page, or null when the
 * remote isn't a hosted URL (local path, file://, …).
 */
export function remoteToWebUrl(raw: string): string | null {
  const trimmed = (raw || "").trim().replace(/\/+$/, "")
  if (!trimmed) return null
  // Absolute local paths can never be web links (also guards Windows "C:\…").
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("file://")) return null
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(trimmed)
  if (scheme) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return null
    const path = stripGitSuffix(parsed.pathname).replace(/\/+$/, "")
    if (!path || path === "/") return null
    return `https://${parsed.hostname}${path}`
  }
  // scp-like syntax: [user@]host:path/to/repo.git
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed)
  if (!scp) return null
  const [, host, path] = scp
  if (!host.includes(".") || path.startsWith("/")) return null
  const clean = stripGitSuffix(path).replace(/\/+$/, "")
  if (!clean) return null
  return `https://${host}/${clean}`
}

/** Provider by hostname — substring match so self-hosted mirrors resolve too. */
export function gitProviderOfWebUrl(webUrl: string): GitProvider {
  let host = ""
  try {
    host = new URL(webUrl).hostname.toLowerCase()
  } catch {
    return "generic"
  }
  if (host === "github.com" || host.endsWith(".github.com") || host.includes("github")) return "github"
  if (host.includes("gitlab")) return "gitlab"
  if (host.includes("bitbucket")) return "bitbucket"
  return "generic"
}

/** Path without leading/trailing slashes, e.g. "/o/r/" -> "o/r". */
export function repoSlugOfWebUrl(webUrl: string): string {
  try {
    return new URL(webUrl).pathname.replace(/^\/+|\/+$/g, "")
  } catch {
    return webUrl
  }
}

/** Attach webUrl/provider/slug; remotes without a web form are dropped. */
export function toRepoLinks(remotes: GitRemote[]): RepoLink[] {
  const out: RepoLink[] = []
  for (const remote of remotes) {
    const webUrl = remoteToWebUrl(remote.url)
    if (!webUrl) continue
    out.push({ ...remote, webUrl, provider: gitProviderOfWebUrl(webUrl), slug: repoSlugOfWebUrl(webUrl) })
  }
  return out
}
