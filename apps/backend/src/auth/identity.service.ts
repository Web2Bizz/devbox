import { Injectable } from '@nestjs/common';

/**
 * Canonical mock user key (dev single-user).
 * Re-exported aliases keep the old controller imports compiling during
 * migration — new code imports from here.
 */
export const DEFAULT_MOCK_USER_ID: string = 'default';

/** Authenticated request identity (JWT user or legacy mock fallback). */
export type RequestIdentity = {
  /** User key — real uuid from JWT, or the mock key under legacy fallback. */
  id: string;
  email: string | null;
  /** True only for the x-user-id / ?userId fallback path. */
  mock: boolean;
};

/**
 * Resolves the MVP mock user key: x-user-id header wins, then ?userId query,
 * then the 'default' dev user. Single copy — github + workspaces controllers
 * delegate here (was duplicated in both).
 */
export function resolveIdentityUserId(request: unknown, queryUserId?: string): string {
  const headers: Record<string, unknown> | undefined =
    typeof request === 'object' && request !== null && 'headers' in request
      ? (request as { headers?: Record<string, unknown> }).headers
      : undefined;
  const fromHeader: unknown = headers?.['x-user-id'];
  const headerId: string | undefined =
    typeof fromHeader === 'string' && fromHeader.trim() !== '' ? fromHeader.trim() : undefined;
  const queryId: string | undefined =
    typeof queryUserId === 'string' && queryUserId.trim() !== '' ? queryUserId.trim() : undefined;
  return headerId ?? queryId ?? DEFAULT_MOCK_USER_ID;
}

/** Reads the request identity attached by JwtAuthGuard (null when anonymous). */
export function readIdentity(request: unknown): RequestIdentity | null {
  if (typeof request !== 'object' || request === null) return null;
  const user: unknown = (request as { user?: unknown }).user;
  if (typeof user !== 'object' || user === null) return null;
  const record: Record<string, unknown> = user as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || record['id'] === '') return null;
  return {
    id: record['id'] as string,
    email: typeof record['email'] === 'string' ? (record['email'] as string) : null,
    mock: record['mock'] === true,
  };
}

@Injectable()
export class IdentityService {
  resolveUserId(request: unknown, queryUserId?: string): string {
    return resolveIdentityUserId(request, queryUserId);
  }

  read(request: unknown): RequestIdentity | null {
    return readIdentity(request);
  }
}
