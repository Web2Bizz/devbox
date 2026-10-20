/**
 * Auth fixtures (kept for type-compat + unit tests).
 * REAL-API: live — `useLogin` calls POST /api/v1/auth/login via
 * `src/api/client.ts` + `src/lib/auth-store.ts`; `MockUser` stays the
 * hook-facing user shape (id/email/name), `isMockCredential` remains only
 * for offline demo/tests (never used by the hook anymore).
 */

export type MockUser = {
  id: string;
  email: string;
  name: string;
};

export const MOCK_USER: MockUser = {
  id: 'mock-user-1',
  email: 'dev@devbox.local',
  name: 'Devbox Developer',
};

/** Any password with length >= 8 succeeds; used for mock validation demo. */
export const MOCK_PASSWORD_MIN_LENGTH = 8;

export function isMockCredential(email: string, password: string): boolean {
  return email.includes('@') && password.length >= MOCK_PASSWORD_MIN_LENGTH;
}
