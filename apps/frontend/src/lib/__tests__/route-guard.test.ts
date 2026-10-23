/**
 * route-guard — redirect matrix + proxy matcher consistency.
 *
 * Covers: guest on auth/root → /login; authed on unauth/root → /projects;
 * public → null; prefix boundaries (no `/loginx` / `/registries`-vs-
 * `/registry` confusion); loop-freedom (destinations are fixed points).
 * Also asserts edge `proxy.ts` matcher covers every guarded prefix —
 * matcher values must be static literals, so the test cross-checks the
 * file text instead of importing `next/server`.
 */
import { describe, expect, test } from 'bun:test';
import { AUTH_PREFIXES, UNAUTH_PREFIXES, isAuthPath, isUnauthPath, resolveAuthRedirect } from '../route-guard';

describe('resolveAuthRedirect matrix', () => {
  const cases: Array<{ path: string; authed: boolean; want: '/login' | '/projects' | null }> = [
    // guest on auth → /login
    { path: '/projects', authed: false, want: '/login' },
    { path: '/projects/abc', authed: false, want: '/login' },
    { path: '/profile', authed: false, want: '/login' },
    { path: '/organizations/org-1', authed: false, want: '/login' },
    { path: '/registry/docker', authed: false, want: '/login' },
    { path: '/chat', authed: false, want: '/login' },
    // guest on root → /login
    { path: '/', authed: false, want: '/login' },
    // authed on auth/root → render
    { path: '/projects', authed: true, want: null },
    { path: '/profile', authed: true, want: null },
    { path: '/', authed: true, want: '/projects' },
    // authed on unauth → /projects
    { path: '/login', authed: true, want: '/projects' },
    { path: '/register', authed: true, want: '/projects' },
    { path: '/restore', authed: true, want: '/projects' },
    // guest on unauth → render
    { path: '/login', authed: false, want: null },
    // public → null either way
    { path: '/icon.png', authed: false, want: null },
    { path: '/icon.png', authed: true, want: null },
    { path: '/_next/static/chunk.js', authed: false, want: null },
    { path: '/unknown', authed: false, want: null },
    { path: '/unknown', authed: true, want: null },
    // prefix boundaries — no false positives
    { path: '/loginx', authed: false, want: null },
    { path: '/profilex', authed: false, want: null },
  ];
  for (const { path, authed, want } of cases) {
    test(`${authed ? 'authed' : 'guest'} ${path} → ${want ?? 'render'}`, () => {
      expect(resolveAuthRedirect(path, authed)).toBe(want);
    });
  }

  test('/registries is not swallowed by /registry prefix', () => {
    expect(isAuthPath('/registries')).toBe(true);
    expect(isAuthPath('/registry')).toBe(true);
    expect(isAuthPath('/registryx')).toBe(false);
  });

  test('unauth/auth sets are disjoint', () => {
    for (const u of UNAUTH_PREFIXES) expect(isAuthPath(u)).toBe(false);
    for (const a of AUTH_PREFIXES) expect(isUnauthPath(a)).toBe(false);
  });

  test('loop-freedom: destinations are fixed points', () => {
    expect(resolveAuthRedirect('/login', false)).toBe(null);
    expect(resolveAuthRedirect('/projects', true)).toBe(null);
    // single hop lands on a fixed point — no /login<->/projects cycle
    const hop1 = resolveAuthRedirect('/login', true);
    expect(hop1).toBe('/projects');
    expect(resolveAuthRedirect(hop1 as string, true)).toBe(null);
    const hop2 = resolveAuthRedirect('/projects', false);
    expect(hop2).toBe('/login');
    expect(resolveAuthRedirect(hop2 as string, false)).toBe(null);
  });
});

describe('proxy.ts matcher consistency', () => {
  test('matcher covers every guarded prefix + root', async () => {
    const source = await Bun.file(new URL('../../../proxy.ts', import.meta.url)).text();
    expect(source).toContain('export function proxy(');
    expect(source).not.toContain('export function middleware(');
    for (const p of [...AUTH_PREFIXES, ...UNAUTH_PREFIXES]) {
      expect(source).toContain(`'${p}/:path*'`);
    }
    expect(source).toContain(`'/'`);
  });
});
