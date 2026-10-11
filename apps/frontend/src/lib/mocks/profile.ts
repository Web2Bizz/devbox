import type { Profile } from '../types';

/**
 * Profile fixture (kept for type-compat + unit tests).
 * REAL-API: live — `useProfile` calls GET/PATCH /api/v1/auth/me via
 * `src/api/client.ts`; this fixture is no longer rendered.
 */
export const MOCK_PROFILE: Profile = {
  id: 'mock-user-1',
  name: 'Devbox Developer',
  email: 'dev@devbox.local',
  role: 'Owner',
  createdAt: '2026-01-15T09:00:00.000Z',
};
