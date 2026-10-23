/**
 * auth-store — expiry / sign-out paths.
 *
 * Covers: isExpiredJwt fail-closed branches (valid / expired / inside-5s-skew
 * / malformed / non-JWT / exp-less), getValidAccessToken passthrough +
 * single-flight refresh, refresh-failure clearing incl. the `devbox-auth`
 * marker cookie, client-side marker stamping on setSession/successful
 * refresh (proxy.ts guard fallback), logoutEverywhere idempotency
 * on 401, signOutAndRedirect (router.replace preferred, push fallback,
 * query-cache clear).
 *
 * No secrets hit logs here — tokens only travel in storage/fetch bodies.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

class FakeApiClientError extends Error {
  code: string;
  status: number;
  correlationId: string;
  constructor(args: { code: string; message: string; status: number; correlationId: string }) {
    super(args.message);
    this.name = 'ApiClientError';
    this.code = args.code;
    this.status = args.status;
    this.correlationId = args.correlationId;
  }
}

let refreshImpl: (input: { refreshToken: string }) => Promise<{ accessToken: string; refreshToken: string }> = async () => {
  throw new FakeApiClientError({ code: 'unauthorized', message: 'no stub', status: 401, correlationId: 'test' });
};
let logoutImpl: (refreshToken?: string) => Promise<{ ok: boolean }> = async () => ({ ok: true });
const refreshMock = mock((input: { refreshToken: string }) => refreshImpl(input));
const logoutMock = mock((rt?: string) => logoutImpl(rt));

mock.module('../../api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: {
    refresh: refreshMock,
    logout: logoutMock,
  },
}));

const store = await import('../auth-store');
const { registerActiveQueryClient } = await import('../query-client');
const { QueryClient } = await import('@tanstack/react-query');

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function mintJwt(exp?: number): string {
  const payload: Record<string, unknown> = { sub: 'u1' };
  if (exp !== undefined) payload.exp = exp;
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const anHourAgo = () => Math.floor(Date.now() / 1000) - 3600;

function makeSession(accessToken: string, refreshToken: string): never {
  return {
    accessToken,
    refreshToken,
    tokenType: 'bearer',
    expiresIn: 900,
    user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', provider: 'local', createdAt: new Date().toISOString() },
  } as never;
}

function seed(accessToken: string, refreshToken: string): void {
  // Маркер `devbox-auth=1` ставит сам setSession (клиентский fallback под
  // proxy.ts) — ручной document.cookie здесь больше не нужен.
  store.setSession(makeSession(accessToken, refreshToken));
}

beforeEach(() => {
  refreshMock.mockClear();
  logoutMock.mockClear();
  registerActiveQueryClient(null);
  refreshImpl = async () => {
    throw new FakeApiClientError({ code: 'unauthorized', message: 'no stub', status: 401, correlationId: 'test' });
  };
  logoutImpl = async () => ({ ok: true });
});

afterEach(() => {
  store.clearSession();
  registerActiveQueryClient(null);
  document.cookie = 'devbox-auth=; path=/; max-age=0';
});

describe('isExpiredJwt (fail-closed)', () => {
  test('valid token (exp +1h) is not expired', () => {
    expect(store.isExpiredJwt(mintJwt(inAnHour()))).toBe(false);
  });

  test('expired token (exp −1h) is expired', () => {
    expect(store.isExpiredJwt(mintJwt(anHourAgo()))).toBe(true);
  });

  test('token expiring inside the 5s skew window counts as expired', () => {
    expect(store.isExpiredJwt(mintJwt(Math.floor(Date.now() / 1000) + 3))).toBe(true);
  });

  test('token expiring outside the skew window is still valid', () => {
    expect(store.isExpiredJwt(mintJwt(Math.floor(Date.now() / 1000) + 30))).toBe(false);
  });

  test('malformed tokens count as expired', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '...', 'header.not-json.sig']) {
      expect(store.isExpiredJwt(bad)).toBe(true);
    }
  });

  test('non-JWT opaque token counts as expired', () => {
    expect(store.isExpiredJwt('test-access')).toBe(true);
  });

  test('JWT without exp counts as expired', () => {
    expect(store.isExpiredJwt(mintJwt(undefined))).toBe(true);
  });
});

describe('getValidAccessToken', () => {
  test('valid access passes through without refresh', async () => {
    seed(mintJwt(inAnHour()), mintJwt(inAnHour()));
    await expect(store.getValidAccessToken()).resolves.toBe(store.getAccessToken());
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test('expired access + valid refresh → single-flight refresh', async () => {
    const fresh = mintJwt(inAnHour());
    seed(mintJwt(anHourAgo()), mintJwt(inAnHour()));
    refreshImpl = async () => ({ accessToken: fresh, refreshToken: mintJwt(inAnHour()) });

    const [a, b] = await Promise.all([store.getValidAccessToken(), store.getValidAccessToken()]);
    expect(a).toBe(fresh);
    expect(b).toBe(fresh);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  test('expired access + dead refresh → null, storage + marker cleared', async () => {
    seed(mintJwt(anHourAgo()), mintJwt(anHourAgo()));
    refreshImpl = async () => {
      throw new FakeApiClientError({ code: 'unauthorized', message: 'expired', status: 401, correlationId: 't' });
    };

    await expect(store.getValidAccessToken()).resolves.toBeNull();
    expect(store.getAccessToken()).toBeNull();
    expect(store.getRefreshToken()).toBeNull();
    expect(document.cookie).not.toContain('devbox-auth=1');
  });

  test('no tokens at all → null without network', async () => {
    await expect(store.getValidAccessToken()).resolves.toBeNull();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('devbox-auth marker (client fallback под proxy.ts)', () => {
  test('setSession сам ставит маркер без ручного document.cookie', () => {
    store.setSession(makeSession(mintJwt(inAnHour()), mintJwt(inAnHour())));
    expect(document.cookie).toContain('devbox-auth=1');
  });

  test('clearSession сносит маркер', () => {
    seed(mintJwt(inAnHour()), mintJwt(inAnHour()));
    expect(document.cookie).toContain('devbox-auth=1');
    store.clearSession();
    expect(document.cookie).not.toContain('devbox-auth=1');
  });

  test('успешный refresh перевыставляет протухший маркер', async () => {
    const fresh = mintJwt(inAnHour());
    seed(mintJwt(anHourAgo()), mintJwt(inAnHour()));
    // Маркер протух/слетел (backend Set-Cookie не долетел), refresh жив.
    document.cookie = 'devbox-auth=; path=/; max-age=0';
    expect(document.cookie).not.toContain('devbox-auth=1');
    refreshImpl = async () => ({ accessToken: fresh, refreshToken: mintJwt(inAnHour()) });

    await expect(store.getValidAccessToken()).resolves.toBe(fresh);
    expect(document.cookie).toContain('devbox-auth=1');
  });
});

describe('logoutEverywhere', () => {
  test('401 from api.logout still clears locally and never throws (idempotent)', async () => {
    seed(mintJwt(anHourAgo()), mintJwt(anHourAgo()));
    logoutImpl = async () => {
      throw new FakeApiClientError({ code: 'unauthorized', message: 'expired', status: 401, correlationId: 't' });
    };

    await expect(store.logoutEverywhere()).resolves.toBeUndefined();
    await expect(store.logoutEverywhere()).resolves.toBeUndefined();
    expect(store.getAccessToken()).toBeNull();
    expect(document.cookie).not.toContain('devbox-auth=1');
  });
});

describe('signOutAndRedirect (единый путь)', () => {
  test('prefers router.replace, clears query cache + marker', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['profile'], { name: 'stale' });
    registerActiveQueryClient(qc);
    seed(mintJwt(anHourAgo()), mintJwt(anHourAgo()));

    const replace = mock(() => {});
    const push = mock(() => {});
    await store.signOutAndRedirect({ router: { replace, push } });

    expect(replace).toHaveBeenCalledWith('/login');
    expect(push).not.toHaveBeenCalled();
    expect(qc.getQueryData(['profile'])).toBeUndefined();
    expect(document.cookie).not.toContain('devbox-auth=1');
  });

  test('falls back to router.push when replace is missing (legacy stub)', async () => {
    seed(mintJwt(anHourAgo()), mintJwt(anHourAgo()));
    const push = mock(() => {});
    await store.signOutAndRedirect({ router: { push } });
    expect(push).toHaveBeenCalledWith('/login');
  });

  test('never throws without router (SSR/tests) — session still cleared', async () => {
    seed(mintJwt(anHourAgo()), mintJwt(anHourAgo()));
    await expect(store.signOutAndRedirect()).resolves.toBeUndefined();
    expect(store.getAccessToken()).toBeNull();
  });
});
