// core/queries/sessions/client — tiny QueryClient-shaped cache.
// No @tanstack dependency: same shape (get/invalidate/subscribe) so
// screens keep data-layer discipline (fetch in resolve.ts, cache here,
// React hooks only in screens/*). Framework-free, no React import.
import type { SessionInfo } from "./types.js";
import type { SessionsFetchOpts } from "./resolve.js";
import { fetchSessions } from "./resolve.js";

export type SessionsSnapshot = {
  status: "idle" | "loading" | "ready" | "error";
  sessions: SessionInfo[];
  error?: string;
};

export function createSessionsClient() {
  let snapshot: SessionsSnapshot = { status: "idle", sessions: [] };
  const listeners = new Set<(snap: SessionsSnapshot) => void>();
  const emit = (): void => {
    const copy: SessionsSnapshot = { ...snapshot, sessions: [...snapshot.sessions] };
    for (const fn of listeners) fn(copy);
  };
  return {
    snapshot: (): SessionsSnapshot => ({ ...snapshot, sessions: [...snapshot.sessions] }),
    subscribe: (fn: (snap: SessionsSnapshot) => void): (() => void) => {
      listeners.add(fn);
      fn({ ...snapshot, sessions: [...snapshot.sessions] });
      return () => {
        listeners.delete(fn);
      };
    },
    refresh: async (opts: SessionsFetchOpts = {}): Promise<SessionsSnapshot> => {
      snapshot = { status: "loading", sessions: [...snapshot.sessions] };
      emit();
      try {
        const sessions = await fetchSessions(opts);
        snapshot = { status: "ready", sessions };
      } catch (err) {
        snapshot = {
          status: "error",
          sessions: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      emit();
      return snapshot;
    },
    invalidate: async (opts: SessionsFetchOpts = {}): Promise<SessionsSnapshot> => {
      try {
        const sessions = await fetchSessions(opts);
        snapshot = { status: "ready", sessions };
      } catch (err) {
        snapshot = {
          status: "error",
          sessions: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      emit();
      return snapshot;
    },
    setLocal: (sessions: SessionInfo[]): void => {
      snapshot = { status: "ready", sessions: [...sessions] };
      emit();
    },
  };
}

export type SessionsClient = ReturnType<typeof createSessionsClient>;
