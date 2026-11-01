/**
 * submodules util unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the other runners):
 *   `bun run build && bun dist/organizations/modules/projects/modules/repository/utils/submodules/__tests__/submodules.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the parsers + jail of `.gitmodules`/`git submodule status`:
 * - `parseGitmodules`: multiple `[submodule "…"]` sections, missing url → null;
 * - `parseSubmoduleStatus`: leading ' ', '+', '-' columns + 4-64 char sha;
 * - `isSubmodulePathSafe`: relative paths inside the repo only, traversal
 *   (`../`, absolute, encoded `%2e%2e`, NUL) rejected;
 * - `readSubmodules` on a directory without `.gitmodules` → [].
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSubmodulePathSafe,
  parseGitmodules,
  parseSubmoduleStatus,
  readSubmodules,
} from '..';

const GITMODULES = [
  '# managed by hand',
  '[submodule "libs/shared"]',
  '  path = libs/shared',
  '  url = https://github.com/acme/shared.git',
  '',
  '[submodule "vendor/peer"]',
  '  path = vendor/peer',
  '',
  '[submodule "deps/desk"]',
  '  ; comment inside a section',
  '  path = deps/desk',
  '  url = git@github.com:acme/desk.git',
].join('\n');

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'parseGitmodules → multiple entries, url null when absent',
    run: () => {
      const parsed = parseGitmodules(GITMODULES);
      assert.deepEqual(parsed, [
        { path: 'libs/shared', url: 'https://github.com/acme/shared.git' },
        { path: 'vendor/peer', url: null },
        { path: 'deps/desk', url: 'git@github.com:acme/desk.git' },
      ]);
      assert.deepEqual(parseGitmodules(''), []);
    },
  },
  {
    name: 'parseSubmoduleStatus → leading +/−/space, sha and path',
    run: () => {
      const stdout = [
        ' 1234567 libs/shared (v1.0)',
        '+89abcde vendor/peer (heads/main)',
        '-abcdef0 deps/desk',
        'garbage line without sha',
        '',
      ].join('\n');
      const rows = parseSubmoduleStatus(stdout);
      assert.deepEqual(rows, [
        { sha: '1234567', path: 'libs/shared', status: ' ' },
        { sha: '89abcde', path: 'vendor/peer', status: '+' },
        { sha: 'abcdef0', path: 'deps/desk', status: '-' },
      ]);
    },
  },
  {
    name: 'isSubmodulePathSafe → safe inside repo, unsafe traversal',
    run: () => {
      for (const safe of ['libs/shared', 'a/b/c', 'deps/desk', 'a/./b']) {
        assert.equal(isSubmodulePathSafe(safe), true, `expected safe: ${safe}`);
      }
      for (const unsafe of [
        '',
        '..',
        '../evil',
        '../../evil',
        '/absolute',
        'a/../../b',
        '..%2f..%2fevil',
        '%2e%2e/x',
        'a\0b',
      ]) {
        assert.equal(isSubmodulePathSafe(unsafe), false, `expected unsafe: ${JSON.stringify(unsafe)}`);
      }
    },
  },
  {
    name: 'readSubmodules without .gitmodules → []',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'submodules-spec-'));
      const dir = path.join(root, 'content');
      mkdirSync(dir, { recursive: true });
      assert.deepEqual(await readSubmodules(dir), []);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} submodules checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} submodules checks failed`);
  }
  console.log(`${checks.length}/${checks.length} submodules checks passed`);
}

void main().catch((err: unknown) => {
  console.error(`submodules checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
