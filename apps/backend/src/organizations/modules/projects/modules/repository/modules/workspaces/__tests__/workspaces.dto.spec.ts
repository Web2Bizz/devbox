import assert from 'node:assert/strict';
import { REPO_URL_ALLOWED_FORMS_MESSAGE } from '../modules/clone/utils/repo-url';
import { workspaceRepoUrlSchema } from '../workspaces.dto';

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite = '';

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = '';
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

const ALLOWED: Array<string> = [
  'https://github.com/acme/demo.git',
  'ssh://git@gitlab.com/acme/demo.git',
  'git@github.com:acme/demo.git',
];

const DENIED: Array<{ name: string; url: string }> = [
  { name: 'file:// URL', url: 'file:///etc/passwd' },
  { name: 'http:// URL', url: 'http://github.com/acme/demo.git' },
  { name: 'git:// URL', url: 'git://github.com/acme/demo.git' },
  { name: 'absolute local path', url: '/srv/repos/demo' },
  { name: 'relative local path', url: '../demo' },
  { name: 'arbitrary scp localpart', url: '-u@github.com:demo' },
  { name: 'userinfo in https', url: 'https://user:pass@github.com/acme/demo.git' },
  { name: 'backslash', url: 'https://github.com/acme\\demo' },
  { name: 'control character', url: 'https://github.com/acme/demo\u0001' },
  { name: 'encoded traversal', url: 'https://github.com/acme/%2e%2e/demo' },
];

describe('workspaceRepoUrlSchema', () => {
  for (const url of ALLOWED) {
    it(`accepts ${url}`, () => {
      const parsed = workspaceRepoUrlSchema.safeParse(url);
      assert.equal(parsed.success, true, `expected ${url} to be accepted`);
    });
  }

  for (const { name, url } of DENIED) {
    it(`rejects ${name} with the service-compatible message`, () => {
      const parsed = workspaceRepoUrlSchema.safeParse(url);
      assert.equal(parsed.success, false, `expected ${name} to be rejected`);
      if (parsed.success) return;
      assert.equal(parsed.error.issues[0]?.message, REPO_URL_ALLOWED_FORMS_MESSAGE);
    });
  }
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`workspaces dto checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
