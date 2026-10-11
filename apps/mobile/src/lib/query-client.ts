import { QueryClient, focusManager } from "@tanstack/react-query"
import { AppState } from "react-native"

// Shared client: imported by the <QueryClientProvider> in app/_layout.tsx AND
// by non-component code (Zustand stores, SSE handlers) that needs
// fetchQuery/getQueryData/setQueryData outside React. Both paths hit the same
// cache because it is a singleton.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Server snapshots (sessions, catalog, project) change rarely and are
      // additionally kept fresh by SSE sync + mutation invalidation, so a
      // modest stale window just dedups the focus/refetch storms. Per-query
      // staleTime overrides (catalog: longer, detail: shorter) where needed.
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      // Mobile + often offline: fail fast and let the UI offer retry instead
      // of hammering a dead server with exponential backoff.
      retry: 2,
      // Revalidate on foreground — wired to AppState via
      // setupQueryFocusManager() below (without it this flag is a noop on RN).
      refetchOnWindowFocus: true,
    },
    mutations: {
      // Writes (create/delete/prompt/abort/reply) must never silently replay.
      retry: false,
    },
  },
})

let focusSetupDone = false

// Connect React Query's focus tracking to the app lifecycle. Must be called
// once from the root layout's mount effect — after this, returning to the app
// refetches every stale mounted query (sessions list, catalog, project info).
export function setupQueryFocusManager() {
  if (focusSetupDone) return
  focusSetupDone = true
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener("change", (status) => {
      handleFocus(status === "active")
    })
    return () => subscription.remove()
  })
}
