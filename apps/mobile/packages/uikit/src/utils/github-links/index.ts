// GitHub URL detection for agent messages.
// Pure — no React Native imports, unit-testable with node --test.
//
// Matches both bare URLs and the target of markdown links
// ([label](https://github.com/owner/repo...)), since the URL itself is
// always present literally in the message text.

const GITHUB_URL_RE = /https?:\/\/(?:www\.)?github\.com\/[^\s<>"'`\])}]+/gi

// Sentence punctuation that can stick to a URL pasted at the end of a
// sentence — never part of the URL itself.
const TRAILING_PUNCT_RE = /[.,;:!?'"’”]+$/

/**
 * Extract unique GitHub (github.com) URLs from message text, in order of
 * first appearance. Returns [] for text without any.
 */
export function extractGitHubUrls(text: string): string[] {
  if (!text) return []
  const matches = text.match(GITHUB_URL_RE)
  if (!matches) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of matches) {
    const url = raw.replace(TRAILING_PUNCT_RE, "")
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}
