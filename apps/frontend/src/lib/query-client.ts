'use client';

import { QueryClient } from '@tanstack/react-query';

/**
 * Shared QueryClient — production-ready cache to avoid hammering the backend.
 *
 * Defaults:
 * - staleTime 30s: list/detail are considered fresh for 30s → no refetch on
 *   remount / window focus within that window (dedup + cache hit).
 * - gcTime 5 min: keep unused cache 5 min before GC.
 * - retry: 1 with exponential backoff (avoid storm on 5xx / network blip).
 * - refetchOnWindowFocus: false — explicit reload via button / invalidate, not
 *   on every focus.
 * - refetchOnReconnect: true — recover after offline.
 * - networkMode: 'online' — pause when offline.
 */
export function createQueryClient(): QueryClient {
  const isTest = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: isTest ? 0 : 30_000,
        gcTime: isTest ? 0 : 5 * 60_000,
        retry: isTest ? false : 1,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30_000),
        refetchOnWindowFocus: false,
        refetchOnReconnect: !isTest,
        networkMode: 'online',
      },
      mutations: {
        retry: 0,
        networkMode: 'online',
      },
    },
  });
}

/**
 * Active-client registry — lets the module-level sign-out path
 * (`signOutAndRedirect` in lib/auth-store, which can't call the
 * `useQueryClient` hook) clear the React Query cache. Providers registers
 * the mounted client; consumers outside a provider (tests) simply get null.
 */
let activeClient: QueryClient | null = null;

export function registerActiveQueryClient(client: QueryClient | null): void {
  activeClient = client;
}

export function getActiveQueryClient(): QueryClient | null {
  return activeClient;
}
