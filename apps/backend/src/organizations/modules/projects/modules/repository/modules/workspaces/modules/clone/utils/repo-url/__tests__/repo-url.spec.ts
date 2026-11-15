import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import {
  BASE_CLONE_HOSTS,
  REPO_URL_ALLOWED_FORMS_MESSAGE,
  buildGitCloneArgs,
  createAllowedCloneHosts,
  normalizeRepoUrl,
} from '../repo-url.util';

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

function allowedHosts(extra: Array<string> = []): Set<string> {
  return createAllowedCloneHosts(extra);
}

function errorCode(err: unknown): string | undefined {
  const getResponse = (err as { getResponse?: unknown } | null)?.getResponse;
  if (typeof getResponse === 'function') {
    const response = (getResponse as () => unknown).call(err);
    if (response && typeof response === 'object' && 'code' in response) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

function isRejected(err: unknown): boolean {
  return (
    err instanceof BadRequestException &&
    errorCode(err) === 'REPO_URL_NOT_ALLOWED' &&
    (err as Error).message.includes(REPO_URL_ALLOWED_FORMS_MESSAGE)
  );
}

function rejectionFor(url: unknown): unknown {
  try {
    normalizeRepoUrl(url, allowedHosts());
    return undefined;
  } catch (err) {
    return err;
  }
}

const ALLOWED: Array<{ name: string; url: string; expected: string }> = [
  {
    name: 'https with a plain host',
    url: 'https://github.com/a/b',
    expected: 'https://github.com/a/b',
  },
  {
    name: 'https with an uppercase host (normalized to lowercase)',
    url: 'https://GitHub.COM/a/b',
    expected: 'https://github.com/a/b',
  },
  {
    name: 'https with an explicit port',
    url: 'https://github.com:8443/a/b',
    expected: 'https://github.com:8443/a/b',
  },
  {
    name: 'ssh with git user',
    url: 'ssh://git@gitlab.com/a/b.git',
    expected: 'ssh://git@gitlab.com/a/b.git',
  },
  {
    name: 'ssh with uppercase host / mixed-case path (host lowercased)',
    url: 'ssh://git@GitHub.com/A/b.git',
    expected: 'ssh://git@github.com/A/b.git',
  },
  {
    name: 'scp form',
    url: 'git@github.com:a/b.git',
    expected: 'git@github.com:a/b.git',
  },
  {
    name: 'scp with uppercase host and path (host lowercased, path preserved)',
    url: 'git@GitHub.COM:A/B.git',
    expected: 'git@github.com:A/B.git',
  },
  {
    name: 'ssh path dot-segments are resolved by the URL parser',
    url: 'ssh://git@github.com/../x',
    expected: 'ssh://git@github.com/x',
  },
];

const DENIED: Array<{ name: string; url: unknown }> = [
  { name: 'file:// URL', url: 'file:///etc/passwd' },
  { name: 'absolute local path', url: '/etc' },
  { name: 'relative local path', url: '../x' },
  { name: 'http:// URL', url: 'http://github.com/a/b' },
  { name: 'git:// URL', url: 'git://github.com/a/b' },
  { name: 'empty value', url: '   ' },
  { name: 'undefined value', url: undefined },
  { name: 'off-list host', url: 'https://evil.example/a/b' },
  { name: 'off-list ssh host', url: 'ssh://git@evil.example/a/b' },
  { name: 'off-list scp host', url: 'git@evil.example:a/b.git' },
  { name: 'host suffix confusion', url: 'https://notgithub.com/a/b' },
  { name: 'host with an evil suffix', url: 'https://github.com.evil.example/a/b' },
  { name: 'host with a trailing dot', url: 'https://github.com./a/b' },
  { name: 'scp host with a trailing dot', url: 'git@github.com.:a/b.git' },
  { name: 'IDN host (homoglyph)', url: 'https://gіthub.com/a/b' },
  { name: 'IPv6 literal', url: 'https://[::1]/a/b' },
  { name: 'numeric IPv4 literal', url: 'https://127.0.0.1/a/b' },
  { name: 'https userinfo (user:pass@)', url: 'https://user:pass@github.com/a/b' },
  { name: 'https username-only userinfo', url: 'https://evil@github.com/a/b' },
  { name: 'https @-in-authority confusion', url: 'https://github.com@evil.example/a/b' },
  { name: 'backslash in an https URL', url: 'https://github.com/a\\b' },
  { name: 'backslash @ in scp form', url: 'git@github.com:a\\@b' },
  { name: 'percent-encoded dot traversal', url: 'https://github.com/a/%2e%2e/b' },
  { name: 'uppercase percent-encoded traversal', url: 'https://github.com/a/%2E%2E/b' },
  { name: 'percent-encoded slash', url: 'https://github.com/a%2fb' },
  { name: 'control character', url: 'https://github.com/a/b\u0001c' },
  { name: 'inner whitespace', url: 'https://github.com/a b' },
  { name: 'arbitrary scp localpart (option injection)', url: '-u@github.com:a/b' },
  { name: 'scp traversal', url: 'git@github.com:../../etc' },
  { name: 'scp traversal in the middle', url: 'git@github.com:a/../../etc' },
  { name: 'ssh without the git user', url: 'ssh://github.com/a/b' },
  { name: 'ssh with a password', url: 'ssh://git:secret@github.com/a/b' },
  { name: 'ssh with a non-git user', url: 'ssh://alice@github.com/a/b' },
];

describe('repo-url normalizeRepoUrl', () => {
  for (const { name, url, expected } of ALLOWED) {
    it(`accepts ${name} and returns the normalized string`, () => {
      assert.equal(normalizeRepoUrl(url, allowedHosts()), expected);
    });
  }

  for (const { name, url } of DENIED) {
    it(`rejects ${name} with 400 REPO_URL_NOT_ALLOWED`, () => {
      const err = rejectionFor(url);
      assert.ok(isRejected(err), `expected 400 REPO_URL_NOT_ALLOWED, got ${String(err)}`);
    });
  }

  it('accepts a host added through CLONE_ALLOWED_HOSTS', () => {
    assert.equal(
      normalizeRepoUrl('https://gitea.internal/a/b', allowedHosts(['gitea.internal'])),
      'https://gitea.internal/a/b',
    );
    assert.equal(
      normalizeRepoUrl('git@GITEA.internal:A/B.git', allowedHosts(['gitea.internal'])),
      'git@gitea.internal:A/B.git',
    );
  });

  it('keeps the built-in hosts when extra hosts are appended', () => {
    const hosts = allowedHosts(['gitea.internal']);
    for (const host of BASE_CLONE_HOSTS) {
      assert.ok(hosts.has(host), `missing built-in host ${host}`);
    }
  });
});

describe('repo-url buildGitCloneArgs', () => {
  it('puts -- before the positional url and destination', () => {
    assert.deepEqual(buildGitCloneArgs('https://github.com/a/b', '/tmp/dest'), [
      'clone',
      '--recurse-submodules',
      '--',
      'https://github.com/a/b',
      '/tmp/dest',
    ]);
  });
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
  console.error(`repo-url checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
