/**
 * Dead-session marker — thrown when both tokens are gone (no backend
 * envelope to throw). Mapped to `t.errors.sessionExpired` in `useMemo`
 * outside `queryFn`, so the fetch itself stays locale-free: language
 * switches neither refetch nor re-render identity consumers.
 *
 * Single definition for the whole client (reuse-first): the class
 * identity IS the contract — every hook that guards a protected v1
 * endpoint checks `error instanceof SessionExpiredError` to stop the
 * React Query retry loop and to pick the translated message. A per-hook
 * copy would silently break those `instanceof` checks across modules
 * (`useProfile`, `useUsage`/features-usage, `useOpencodeSessions`).
 *
 * Stays a plain `Error` with `name === 'SessionExpiredError'` and
 * `message === 'session-expired'` — the shape the existing tests and
 * the `formatApiError` fallback rely on.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('session-expired');
    this.name = 'SessionExpiredError';
  }
}
