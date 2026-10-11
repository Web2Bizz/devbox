/**
 * Maps a 400 `ApiClientError.message` (first zod issue, e.g.
 * "must be a valid email") to per-field messages. The backend sends only
 * the first issue text without a field path, so matching is keyword-based;
 * unknown texts fall back to the raw server message under the best guess.
 * Never carries secrets — messages only.
 */
export function parseRegisterFieldErrors(message: string): Record<string, string> {
  const lower = message.toLowerCase();
  if (lower.includes('valid email')) return { email: message };
  if (lower.includes('≤ 320') || lower.includes('320 chars')) return { email: message };
  if (lower.includes('8 characters') || lower.includes('≤ 256') || lower.includes('256 chars')) {
    return { password: message };
  }
  if (lower.includes('≤ 100') || lower.includes('100 chars')) return { firstName: message };
  if (lower.includes('must not be empty') || lower.includes('not be empty')) {
    return { firstName: message };
  }
  return { firstName: message };
}
