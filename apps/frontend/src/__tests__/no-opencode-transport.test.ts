/**
 * ARCHITECTURE GUARD — the frontend knows nothing about the session runner.
 *
 * Invariant (the user's own words, cards 5-6): "во фронтенде не должно быть
 * opencode sdk никакого; фронт обращается к бэкенду" — every browser call
 * goes through the backend domain contract (/api/v1/sessions*, /api/v1 auth/
 * org/project surfaces), never a runner SDK, never the deprecated mirror
 * transport paths.
 *
 * What this catches (transport/dependency only, NOT the product dictionary):
 *  - the runner sdk dependency (package.json + any import from it);
 *  - any mirror-transport path string in sources (imports, URLs, comments —
 *    comments are held to the rule too so stale transport claims cannot
 *    silently re-point a call).
 * What it deliberately allows: product vocabulary that names the USER'S OWN
 * opencode key/quota feature (the OpencodeKey / OpencodeUsage type families,
 * the opencode_key_* wire codes, i18n copy about keys/usage) — that is
 * domain language about our product, not knowledge of the runner's wire
 * format.
 *
 * Runs in the frontend bun-test contour (static fs scan, no runtime app
 * code involved).
 */
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const FRONTEND_ROOT = resolve(dirname(import.meta.dir), '..'); // src/__tests__ -> apps/frontend
const SELF = 'src/__tests__/no-opencode-transport.test.ts';

// Built by concatenation so this file never contains the forbidden literals.
const FORBIDDEN: Array<{ needle: string; label: string }> = [
  { needle: ['@opencode', '-ai/sdk'].join(''), label: 'runner sdk dependency' },
  { needle: ['/api/', 'opencode'].join(''), label: 'deprecated mirror transport path' },
];

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // skip build/cache noise — only sources and configs are contract
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|cjs|json)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...walk(join(FRONTEND_ROOT, 'src'), []),
  ...walk(join(FRONTEND_ROOT, 'app'), []),
  join(FRONTEND_ROOT, 'package.json'),
];

test('guard covers real files (a silent zero-file scan is itself a regression)', () => {
  // src + app + package.json: the frontend is well past 50 source files.
  expect(files.length).toBeGreaterThan(50);
  const rels = files.map((f) => f.replace(FRONTEND_ROOT + '/', ''));
  expect(rels).toContain('package.json');
  expect(rels.some((r) => r.startsWith('src/api/'))).toBe(true);
});

test('no runner sdk and no mirror transport anywhere in the frontend', () => {
  const violations: string[] = [];
  for (const file of files) {
    const rel = file.replace(FRONTEND_ROOT + '/', '');
    if (rel === SELF) continue; // this file constructs the needles on purpose
    const text = readFileSync(file, 'utf8');
    for (const { needle, label } of FORBIDDEN) {
      if (text.includes(needle)) violations.push(`${rel}: ${label} ("${needle}")`);
    }
  }
  expect(violations).toEqual([]);
});

test('package.json declares no runner sdk dependency (dependencies or dev)', () => {
  const pkg = JSON.parse(readFileSync(join(FRONTEND_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const sdk = ['@opencode', '-ai/sdk'].join('');
  expect(Object.keys(pkg.dependencies ?? {})).not.toContain(sdk);
  expect(Object.keys(pkg.devDependencies ?? {})).not.toContain(sdk);
});
