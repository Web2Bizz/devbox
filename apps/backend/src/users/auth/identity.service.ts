import { Injectable } from '@nestjs/common';

/**
 * Canonical mock user key (dev single-user).
 * Re-exported aliases keep the old controller imports compiling during
 * migration — new code imports from here.
 */
export const DEFAULT_MOCK_USER_ID = 'default';

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
export function resolveIdentityUserId(req: unknown, queryUserId?: string): string {
  const headers =
    typeof req === 'object' && req !== null && 'headers' in req
      ? (req as { headers?: Record<string, unknown> }).headers
      : undefined;
  const fromHeader = headers?.['x-user-id'];
  const headerId =
    typeof fromHeader === 'string' && fromHeader.trim() !== '' ? fromHeader.trim() : undefined;
  const queryId =
    typeof queryUserId === 'string' && queryUserId.trim() !== '' ? queryUserId.trim() : undefined;
  return headerId ?? queryId ?? DEFAULT_MOCK_USER_ID;
}

/** Reads the request identity attached by JwtAuthGuard (null when anonymous). */
export function readIdentity(req: unknown): RequestIdentity | null {
  if (typeof req !== 'object' || req === null) return null;
  const user = (req as { user?: unknown }).user;
  if (typeof user !== 'object' || user === null) return null;
  const rec = user as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || rec['id'] === '') return null;
  return {
    id: rec['id'] as string,
    email: typeof rec['email'] === 'string' ? (rec['email'] as string) : null,
    mock: rec['mock'] === true,
  };
}

@Injectable()
export class IdentityService {
  resolveUserId(req: unknown, queryUserId?: string): string {
    return resolveIdentityUserId(req, queryUserId);
  }

  read(req: unknown): RequestIdentity | null {
    return readIdentity(req);
  }
}
