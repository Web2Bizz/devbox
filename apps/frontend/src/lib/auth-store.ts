import { api } from '../api/client';
import type { AuthSession } from '../api/types';
import { getActiveQueryClient } from './query-client';

const ACCESS_KEY = 'devbox-access-token';
const REFRESH_KEY = 'devbox-refresh-token';
/** Readable marker cookie the backend sets on login/register/refresh and
 *  clears on logout — middleware.ts redirects on it alone. */
const AUTH_MARKER = 'devbox-auth';
/**
 * Дефолтный TTL маркера (7d = 604800s) — зеркалит backend
 * DEFAULT_JWT_REFRESH_TTL_SEC (apps/backend/src/env.ts). AuthSession несёт
 * только access `expiresIn` (~900s); refresh TTL до клиента не доезжает,
 * поэтому маркер живёт дефолтом, а не expiresIn (иначе middleware начал бы
 * отбивать /projects → /login через 15 минут при живом refresh).
 */
const DEFAULT_MARKER_MAX_AGE_SEC = 604_800;
/** Clock-skew / race запас: токен, живущий меньше этого, уже протух. */
const EXP_SKEW_MS = 5_000;

/**
 * Token store — access in memory (mirrored to localStorage so reloads
 * survive), refresh via the httpOnly `devbox-refresh` cookie (backend-set,
 * sent with `credentials: 'include'`) + a localStorage fallback copy for
 * the JSON-body refresh path. Carries no secrets into logs — values stay
 * in storage/fetch bodies only.
 */

let memoryAccess: string | null = null;
let memoryRefresh: string | null = null;
let refreshInflight: Promise<string | null> | null = null;

function readStorage(key: string): string | null {
  try {
    if (typeof window !== 'undefined') return window.localStorage.getItem(key);
  } catch {
    // private mode / blocked storage — memory still applies
  }
  return null;
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // persistence is best-effort
  }
}

export function setSession(session: AuthSession): void {
  memoryAccess = session.accessToken;
  memoryRefresh = session.refreshToken;
  writeStorage(ACCESS_KEY, session.accessToken);
  writeStorage(REFRESH_KEY, session.refreshToken);
  // Клиентский дубликат маркера для middleware (см. setAuthMarker):
  // backend Set-Cookie на кросс-портовом dev к origin'у фронтенда не долетает.
  setAuthMarker();
}

export function getAccessToken(): string | null {
  return memoryAccess ?? readStorage(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return memoryRefresh ?? readStorage(REFRESH_KEY);
}

export function clearSession(): void {
  memoryAccess = null;
  memoryRefresh = null;
  refreshInflight = null;
  writeStorage(ACCESS_KEY, null);
  writeStorage(REFRESH_KEY, null);
  clearAuthMarker();
}

/**
 * Client-side установка маркера `devbox-auth=1` (path=/, SameSite=Lax) —
 * fallback-дубликат backend Set-Cookie из setSessionCookies
 * (apps/backend/src/auth/auth.controller.ts: login/register/refresh).
 * Нужен потому что на кросс-портовом dev (фронт :3001 → API :3000) браузер
 * привязывает backend Set-Cookie к origin'у backend'а (SameSite=Lax,
 * domain = хост API, CORS credentials), а middleware.ts читает куки
 * origin'а фронтенда — маркера нет, и /projects отбивается в /login даже
 * при успешном login 200. document.cookie ставит маркер на origin фронтенда;
 * когда оба origin'а совпадают (прод за одним доменом) — идемпотентно
 * перезаписывает то же имя/значение/path. Токены не светит (только "1").
 * Best-effort, never throws; симметричен clearAuthMarker.
 */
export function setAuthMarker(maxAgeSec: number = DEFAULT_MARKER_MAX_AGE_SEC): void {
  try {
    if (typeof document === 'undefined') return;
    const ttl = Number.isFinite(maxAgeSec) && maxAgeSec > 0 ? Math.floor(maxAgeSec) : DEFAULT_MARKER_MAX_AGE_SEC;
    document.cookie = `${AUTH_MARKER}=1; path=/; max-age=${ttl}; SameSite=Lax`;
  } catch {
    // cookie store unavailable — middleware redirect stays backend-driven
  }
}

/**
 * Client-side fallback сноc маркера `devbox-auth` (path=/). The backend
 * clears it via Set-Cookie on /auth/logout, but when logout 401s (expired
 * refresh) or the network fails the marker would outlive the session and
 * middleware.ts would bounce /login → /projects forever — so every local
 * sign-out path drops it too. Best-effort, never throws.
 */
export function clearAuthMarker(): void {
  try {
    if (typeof document === 'undefined') return;
    document.cookie = `${AUTH_MARKER}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0`;
  } catch {
    // cookie store unavailable — middleware redirect stays backend-driven
  }
}

function decodeJwtPayload(token: string): { exp?: unknown } {
  const segment = token.split('.')[1] ?? '';
  if (!segment) throw new Error('not a JWT');
  // base64url → base64 (atob is browser-native; Buffer only as SSR/test fallback).
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (segment.length % 4)) % 4);
  let json: string;
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    json = new TextDecoder().decode(bytes);
  } else if (typeof Buffer !== 'undefined') {
    json = Buffer.from(segment, 'base64url').toString('utf8');
  } else {
    throw new Error('no base64 decoder available');
  }
  return JSON.parse(json) as { exp?: unknown };
}

/**
 * Fail-closed expiry check: malformed / non-JWT / exp-less tokens count as
 * expired (previous Buffer-based version threw ReferenceError in browsers
 * and its catch returned false — a stale access looked valid forever and
 * proactive refresh never fired).
 */
export function isExpiredJwt(token: string): boolean {
  try {
    const payload = decodeJwtPayload(token);
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return true;
    return payload.exp * 1000 <= Date.now() + EXP_SKEW_MS;
  } catch {
    return true;
  }
}

function doRefresh(rt: string): Promise<string | null> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = api
    .refresh({ refreshToken: rt })
    .then((pair) => {
      memoryAccess = pair.accessToken;
      memoryRefresh = pair.refreshToken;
      writeStorage(ACCESS_KEY, pair.accessToken);
      writeStorage(REFRESH_KEY, pair.refreshToken);
      // Ротация продлила сессию — обновляем и маркер, иначе протухший
      // max-age выкинет пользователя из /projects в /login при живом refresh.
      setAuthMarker();
      return pair.accessToken as string;
    })
    .catch(() => {
      clearSession();
      return null;
    })
    .finally(() => {
      refreshInflight = null;
    });
  return refreshInflight;
}

/**
 * Single-flight refresh: valid (non-expired) access passes through,
 * otherwise one POST /auth/refresh runs for all concurrent callers.
 * Null → signed out (caller redirects to /login).
 */
export function getValidAccessToken(): Promise<string | null> {
  const current = getAccessToken();
  if (current && !isExpiredJwt(current)) return Promise.resolve(current);
  const rt = getRefreshToken();
  if (!rt) {
    if (current) clearSession();
    return Promise.resolve(null);
  }
  return doRefresh(rt);
}

/** Force refresh even when memory/localStorage still holds an (expired) access token — for 401 retry. */
export function refreshAccessToken(): Promise<string | null> {
  const rt = getRefreshToken();
  if (!rt) {
    clearSession();
    return Promise.resolve(null);
  }
  return doRefresh(rt);
}

/** Best-effort server logout + local clear (never throws — sign-out always lands). */
export async function logoutEverywhere(): Promise<void> {
  const rt = getRefreshToken();
  try {
    await api.logout(rt ?? undefined);
  } catch {
    // backend unreachable / 401 on expired refresh — local session still clears below
  }
  clearSession();
}

export interface SignOutRouter {
  replace?: (href: string) => void;
  push?: (href: string) => void;
}

/**
 * Единый путь sign-out: серверный revoke (best-effort, идемпотентный) →
 * снос memory + localStorage + cookie-маркера → инвалидация React Query
 * кэша → router.replace('/login'). Не бросает никогда: каждый шаг guarded,
 * в крайнем случае — window.location. Все callers (useLogin logout,
 * profile-dropdown handleSignOut, useProfile sessionExpired) идут сюда.
 */
export async function signOutAndRedirect(options?: { router?: SignOutRouter | null }): Promise<void> {
  try {
    await logoutEverywhere();
  } catch {
    // logoutEverywhere never throws by contract — belt & suspenders
  }
  clearSession();
  try {
    getActiveQueryClient()?.clear();
  } catch {
    // cache clear is best-effort (e.g. no provider mounted in tests)
  }
  const router = options?.router;
  try {
    if (router && typeof router.replace === 'function') {
      router.replace('/login');
      return;
    }
    if (router && typeof router.push === 'function') {
      router.push('/login');
      return;
    }
  } catch {
    // router failed — fall through to location
  }
  try {
    if (typeof window !== 'undefined') window.location.replace('/login');
  } catch {
    // nowhere to navigate (SSR/tests) — session is still cleared above
  }
}
