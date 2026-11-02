import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AppLogger } from '../../../../../../../../../../common/logger';
import type { WorkspacePathService } from '../../../../../../../../../../common/storage/workspace-path.service';
import type { CloneJobsRepository } from '../clone-jobs.repository';
import { WorkspaceCloneService } from '../workspace-clone.service';

// The clone host allow-list is read from the validated AppEnv; unit runs have
// no .env, so supply the one mandatory listen port validateEnv() requires and
// a deterministic extra host to prove CLONE_ALLOWED_HOSTS wiring.
process.env.APP_BACKEND_PORT ??= '3000';
process.env.CLONE_ALLOWED_HOSTS = 'gitea.internal';

const UID = '123e4567-e89b-12d3-a456-426614174001';
const PID = '123e4567-e89b-12d3-a456-426614174003';
const JAIL = '/tmp/repos';
const INSIDE_DEST = `${JAIL}/users/${UID}/projects/${PID}/content`;

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

function silentLogger(): AppLogger {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as AppLogger;
}

type Resolved = {
  scope: 'user';
  scopeId: string;
  projectId: string;
  absBase: string;
  absRepo: string;
  absSecrets: string;
  scopeSecrets: string;
  abs: string;
  rel: string;
};

function resolvedAt(absRepo: string): Resolved {
  const absBase = absRepo.replace(/\/content$/, '');
  return {
    scope: 'user',
    scopeId: UID,
    projectId: PID,
    absBase,
    absRepo,
    absSecrets: `${absBase}/.secrets`,
    scopeSecrets: `${JAIL}/users/${UID}/.secrets`,
    abs: absRepo,
    rel: '.',
  };
}

type JobsMock = {
  withLock: <T>(userId: string, repoName: string, fn: () => Promise<T>) => Promise<T>;
  enqueue: (input: {
    userId: string;
    userSpace: string;
    repoName: string;
    repoUrl: string;
  }) => { job: Record<string, unknown>; created: boolean };
  get: (userId: string, repoName: string) => Record<string, unknown> | null;
};

/**
 * A jobs store whose enqueued job is already `ready` and `created: false`:
 * runClone short-circuits on the ready snapshot, so no mkdir/git ever runs
 * while the assertion still sees the normalized repoUrl the service stored.
 */
function readyJobs(
  onWithLock?: () => void,
): { jobs: JobsMock; store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  const key = (userId: string, repoName: string): string => `${userId}::${repoName}`;
  const jobs: JobsMock = {
    withLock: async <T>(userId: string, repoName: string, fn: () => Promise<T>): Promise<T> => {
      void userId;
      void repoName;
      onWithLock?.();
      return fn();
    },
    enqueue: (input) => {
      const job: Record<string, unknown> = {
        userId: input.userId,
        userSpace: input.userSpace,
        repoName: input.repoName,
        repoUrl: input.repoUrl,
        status: 'ready',
        progress: 100,
        error: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      store.set(key(input.userId, input.repoName), job);
      return { job, created: false };
    },
    get: (userId, repoName) => store.get(key(userId, repoName)) ?? null,
  };
  return { jobs, store };
}

type PathsMock = {
  resolveUser: (userId: string, projectId: string) => Promise<Resolved>;
  assertInsideJail: (abs: string, jailReal: string) => Promise<string>;
  realStrictRoot: () => Promise<string>;
};

function service(
  paths: Partial<PathsMock>,
  jobs: JobsMock,
): WorkspaceCloneService {
  return new WorkspaceCloneService(
    paths as unknown as WorkspacePathService,
    jobs as unknown as CloneJobsRepository,
    silentLogger(),
  );
}

function errorStatus(err: unknown): number | undefined {
  const getStatus = (err as { getStatus?: unknown } | null)?.getStatus;
  if (typeof getStatus !== 'function') return undefined;
  const status = (getStatus as () => unknown).call(err);
  return typeof status === 'number' ? status : undefined;
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
  const direct = (err as { code?: unknown } | null)?.code;
  return typeof direct === 'string' ? direct : undefined;
}

function describeError(err: unknown): string {
  if (err === undefined) return '<no error>';
  const maybe = err as { constructor?: { name?: string }; message?: string };
  const name = maybe?.constructor?.name ?? typeof err;
  return `${name}(status=${errorStatus(err) ?? '?'}, code=${errorCode(err) ?? '?'}): ${maybe?.message ?? String(err)}`;
}

function isRepoUrlRejected(err: unknown): boolean {
  return err instanceof BadRequestException && errorStatus(err) === 400 && errorCode(err) === 'REPO_URL_NOT_ALLOWED';
}

function isForbidden(err: unknown): boolean {
  return err instanceof ForbiddenException || errorStatus(err) === 403;
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return err;
  }
}

const ALLOWED: Array<{ url: string; host: string; expected: string }> = [
  { url: 'https://github.com/a/b', host: 'github.com', expected: 'https://github.com/a/b' },
  {
    url: 'https://GitHub.COM/a/b',
    host: 'github.com',
    expected: 'https://github.com/a/b',
  },
  {
    url: 'https://github.com:8443/a/b',
    host: 'github.com',
    expected: 'https://github.com:8443/a/b',
  },
  {
    url: 'git@github.com:a/b.git',
    host: 'github.com',
    expected: 'git@github.com:a/b.git',
  },
  {
    url: 'git@GitHub.COM:A/B.git',
    host: 'github.com',
    expected: 'git@github.com:A/B.git',
  },
  {
    url: 'ssh://git@gitlab.com/a/b.git',
    host: 'gitlab.com',
    expected: 'ssh://git@gitlab.com/a/b.git',
  },
  {
    url: 'https://bitbucket.org/a/b',
    host: 'bitbucket.org',
    expected: 'https://bitbucket.org/a/b',
  },
  {
    url: 'https://gitea.internal/a/b',
    host: 'gitea.internal',
    expected: 'https://gitea.internal/a/b',
  },
];

const DENIED: Array<string> = [
  'file:///etc/passwd',
  '/etc',
  '../x',
  'http://github.com/a/b',
  'git://github.com/a/b',
  'https://evil.example/a/b',
  'ssh://git@evil.example/a/b',
  'git@evil.example:a/b.git',
  'https://notgithub.com/a/b',
  'https://github.com.evil.example/a/b',
  'https://github.com@evil.example/a/b',
  'https://user:pass@github.com/a/b',
  'https://evil@github.com/a/b',
  'https://github.com./a/b',
  'https://gіthub.com/a/b',
  'https://[::1]/a/b',
  'https://127.0.0.1/a/b',
  'https://github.com/a/%2e%2e/b',
  'https://github.com/a%2fb',
  'https://github.com/a\\b',
  '-u@github.com:a/b',
  'git@github.com:../../etc',
  'git@github.com:a/../../etc',
  'git@github.com.:a/b.git',
  'ssh://github.com/a/b',
  'ssh://alice@github.com/a/b',
];

function permissivePaths(): PathsMock {
  return {
    resolveUser: async () => resolvedAt(INSIDE_DEST),
    realStrictRoot: async () => JAIL,
    assertInsideJail: async (abs) => abs,
  };
}

describe('WorkspaceCloneService.clone repoUrl allow-list', () => {
  for (const { url, host, expected } of ALLOWED) {
    it(`accepts ${url} and stores the normalized value`, async () => {
      const { jobs } = readyJobs();
      const svc = service(permissivePaths(), jobs);
      const job = (await svc.clone(UID, url, PID)) as unknown as { repoUrl?: unknown };
      assert.equal(typeof job.repoUrl, 'string', 'the job must carry the normalized repoUrl');
      assert.ok(
        String(job.repoUrl).includes(host),
        `normalized url must keep host ${host}, got ${String(job.repoUrl)}`,
      );
      assert.equal(
        job.repoUrl,
        expected,
        `the validated/normalized url must be what reaches git, got ${String(job.repoUrl)}`,
      );
    });
  }

  for (const url of DENIED) {
    it(`rejects ${url} with 400 REPO_URL_NOT_ALLOWED`, async () => {
      const { jobs } = readyJobs();
      const svc = service(permissivePaths(), jobs);
      const err = await catchError(() => svc.clone(UID, url, PID));
      assert.ok(
        isRepoUrlRejected(err),
        `expected 400 REPO_URL_NOT_ALLOWED, got ${describeError(err)}`,
      );
    });
  }
});

describe('WorkspaceCloneService.clone hostile repoUrl values', () => {
  const boundary: Array<{ name: string; url: unknown }> = [
    { name: 'undefined repoUrl', url: undefined },
    { name: 'empty repoUrl', url: '   ' },
    { name: 'repoUrl longer than 2048 chars', url: `https://github.com/a/${'x'.repeat(2048)}` },
    { name: 'repoUrl containing a null byte', url: 'https://github.com/a/b\0c' },
  ];

  for (const { name, url } of boundary) {
    it(`answers 400 for ${name}`, async () => {
      const { jobs } = readyJobs();
      const svc = service(permissivePaths(), jobs);
      const err = await catchError(() => svc.clone(UID, url as string, PID));
      assert.equal(errorStatus(err), 400, `expected 400, got ${describeError(err)}`);
    });
  }
});

describe('WorkspaceCloneService.clone destination jail', () => {
  it('asserts the destination is inside the jail before enqueueing', async () => {
    const seq: Array<string> = [];
    const { jobs } = readyJobs(() => seq.push('withLock'));
    const paths: PathsMock = {
      resolveUser: async () => {
        seq.push('resolveUser');
        return resolvedAt(INSIDE_DEST);
      },
      realStrictRoot: async () => {
        seq.push('realStrictRoot');
        return JAIL;
      },
      assertInsideJail: async (abs, jailReal) => {
        seq.push(`assertInsideJail:${abs}:${jailReal}`);
        return abs;
      },
    };
    const svc = service(paths, jobs);
    await svc.clone(UID, 'https://github.com/a/b', PID);
    const jailCalls = seq
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith('assertInsideJail:'));
    assert.ok(jailCalls.length > 0, 'clone must call assertInsideJail on the destination');
    const destCall = jailCalls.find(({ entry }) => entry.includes(INSIDE_DEST));
    assert.ok(destCall, `no jail check received the destination ${INSIDE_DEST}: ${seq.join(' | ')}`);
    assert.ok(
      destCall.entry.includes(JAIL),
      `jail check must receive the real strict root ${JAIL}, got ${destCall.entry}`,
    );
    const lockAt = seq.indexOf('withLock');
    assert.ok(lockAt !== -1, 'a jailed-in destination must reach the clone lock');
    assert.ok(destCall.index < lockAt, 'jail check must precede the locked enqueue');
  });

  it('answers 403 and never enqueues when the destination escapes the jail', async () => {
    const seq: Array<string> = [];
    const { jobs, store } = readyJobs(() => seq.push('withLock'));
    const paths: PathsMock = {
      resolveUser: async () => {
        seq.push('resolveUser');
        return resolvedAt('/etc');
      },
      realStrictRoot: async () => {
        seq.push('realStrictRoot');
        return JAIL;
      },
      assertInsideJail: async (abs) => {
        seq.push(`assertInsideJail:${abs}`);
        if (abs !== JAIL && !abs.startsWith(`${JAIL}/`)) {
          throw new ForbiddenException('Path traversal is forbidden');
        }
        return abs;
      },
    };
    const svc = service(paths, jobs);
    const err = await catchError(() => svc.clone(UID, 'https://github.com/a/b', PID));
    assert.ok(isForbidden(err), `expected 403, got ${describeError(err)}`);
    assert.ok(!seq.includes('withLock'), 'a jailed-out destination must not reach the clone lock');
    assert.equal(store.size, 0, 'a jailed-out destination must not create a clone job');
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
  console.error(`clone service checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
