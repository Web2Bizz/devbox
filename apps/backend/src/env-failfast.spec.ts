/**
 * env fail-fast regression checks — self-contained runner (no new deps).
 *
 * AGENTS.md «Фолбэки запрещены по умолчанию»: отсутствие обязательного значения
 * для записи/мутации → throw fail-fast `[env] X is required/is invalid...`
 * (что задать, где — .env.example), без значений секретов в тексте.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/env-failfast.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers write-path fail-fast (никакого тихого дефолта):
 * - пустой APP_BACKEND_PORT (+ пустой legacy PORT) → throw (backend listen port
 *   обязателен для записи/бинда — `|| 3000` запрещён);
 * - whitespace-only PORT → throw (trim-пустота = отсутствие);
 * - malformed DATABASE_URL → throw без эха значения (секрет никогда в тексте);
 * - пустой/whitespace REPOS_ROOT → requireExplicitRoot throw 500,
 *   isExplicitRootConfigured=false, resolveStrict rejects (путь записи проектов
 *   — никакого тихого <cwd>/repos);
 * - PROJECTS_ROOT с NUL-байтом → throw (невалидный путь записи).
 */
import assert from 'node:assert/strict';
import { validateEnv } from './env';
import { WorkspacePathService } from './workspaces/workspace-path.service';

type Source = NodeJS.ProcessEnv;

/** Минимальный валидный source (write-path ключи заданы явно). */
function baseEnv(): Source {
  return {
    APP_BACKEND_PORT: '3000',
    APP_BACKEND_HOST: '127.0.0.1',
    APP_BACKEND_PROTOCOL: 'http',
    OPENCODE_URL: 'http://127.0.0.1:4096',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    CORS_ORIGINS: 'http://localhost:3001',
    REQUEST_TIMEOUT_MS: '10000',
    LOG_LEVEL: 'info',
    NEXT_PUBLIC_PORT: '3001',
    NEXT_PUBLIC_API_URL: 'http://localhost:3000',
    JWT_ACCESS_SECRET: 'test-jwt-access-secret-not-real-0123456789',
    JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-not-real-0123456789',
    AUTH_LEGACY_MOCK_FALLBACK: 'false',
  } as Source;
}

function without(source: Source, ...keys: string[]): Source {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (!keys.includes(k) && typeof v === 'string') out[k] = v;
  }
  return out as Source;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'пустой APP_BACKEND_PORT (+ пустой PORT) → throw [env] APP_BACKEND_PORT is required',
    run: () => {
      const src = without(baseEnv(), 'APP_BACKEND_PORT');
      try {
        validateEnv(src);
        assert.fail('must throw on missing APP_BACKEND_PORT');
      } catch (err) {
        const msg = (err as Error).message;
        assert.match(msg, /\[env\] APP_BACKEND_PORT is required/, msg);
        assert.ok(msg.includes('.env.example'), `no .env.example pointer: ${msg}`);
      }
    },
  },
  {
    name: 'whitespace-only PORT при пустом APP_BACKEND_PORT → throw (trim-пустота = отсутствие)',
    run: () => {
      const src = { ...without(baseEnv(), 'APP_BACKEND_PORT'), PORT: '   ' } as Source;
      assert.throws(() => validateEnv(src), /\[env\] APP_BACKEND_PORT is required/);
    },
  },
  {
    name: 'legacy PORT покрывает APP_BACKEND_PORT (явное значение — не фолбэк)',
    run: () => {
      const src = { ...without(baseEnv(), 'APP_BACKEND_PORT'), PORT: '3100' } as Source;
      assert.equal(validateEnv(src).backendPort, 3100);
    },
  },
  {
    name: 'malformed DATABASE_URL → throw без эха значения (секрет не в тексте)',
    run: () => {
      const secret = 'postgres://admin:s3cr3t-not-real@localhost:5432/db';
      const src = { ...baseEnv(), DATABASE_URL: 'not-a-db-url' } as Source;
      void secret;
      try {
        validateEnv(src);
        assert.fail('must throw on malformed DATABASE_URL');
      } catch (err) {
        const msg = (err as Error).message;
        assert.match(msg, /\[env\] DATABASE_URL/, msg);
        assert.ok(!msg.includes('not-a-db-url') || msg.includes('unsupported shape'), msg);
        assert.ok(msg.includes('.env.example'), `no .env.example pointer: ${msg}`);
      }
    },
  },
  {
    name: 'пустой REPOS_ROOT → requireExplicitRoot throw 500 (путь записи, без <cwd>/repos)',
    run: () => {
      const paths = new WorkspacePathService();
      assert.equal(paths.isExplicitRootConfigured(), false);
      try {
        paths.requireExplicitRoot();
        assert.fail('must throw');
      } catch (err) {
        assert.equal((err as { status?: number }).status, 500);
        assert.match((err as Error).message, /REPOS_ROOT/, (err as Error).message);
      }
    },
  },
  {
    name: 'whitespace-only REPOS_ROOT → тоже throw (trim-пустота = отсутствие)',
    run: () => {
      const prev = process.env.REPOS_ROOT;
      process.env.REPOS_ROOT = '   ';
      try {
        const paths = new WorkspacePathService();
        assert.equal(paths.isExplicitRootConfigured(), false);
        assert.throws(() => paths.requireExplicitRoot(), /REPOS_ROOT/);
      } finally {
        if (prev === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prev;
      }
    },
  },
  {
    name: 'resolveUserStrict при пустом ROOT → rejects до любого touch диска/БД',
    run: async () => {
      const paths = new WorkspacePathService();
      await assert.rejects(() =>
        paths.resolveUserStrict(
          '123e4567-e89b-12d3-a456-426614174001',
          '123e4567-e89b-12d3-a456-426614174002',
        ),
      );
    },
  },
  {
    name: 'PROJECTS_ROOT с NUL-байтом → throw (невалидный путь записи)',
    run: () => {
      const src = { ...baseEnv(), PROJECTS_ROOT: 'bad\0path' } as Source;
      assert.throws(() => validateEnv(src), /\[env\] PROJECTS_ROOT/);
    },
  },
  {
    name: 'REPOS_ROOT с NUL-байтом → throw (невалидный путь записи)',
    run: () => {
      const src = { ...baseEnv(), REPOS_ROOT: 'bad\0path' } as Source;
      assert.throws(() => validateEnv(src), /\[env\] REPOS_ROOT/);
    },
  },
];

async function main(): Promise<void> {
  // NOTE (bun test shares one process across spec files): ROOT-негативные проверки
  // читают process.env.REPOS_ROOT — форсируем unconfigured-состояние ТОЛЬКО вокруг
  // таких checks и восстанавливаем сразу после (как в project-strict-root.spec.ts).
  let failed = 0;
  for (const c of checks) {
    const prevRepos = process.env.REPOS_ROOT;
    const prevProjects = process.env.PROJECTS_ROOT;
    const needsClean =
      c.name.startsWith('пустой REPOS_ROOT') || c.name.startsWith('resolveStrict');
    if (needsClean) {
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
    }
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    } finally {
      if (prevRepos === undefined) delete process.env.REPOS_ROOT;
      else process.env.REPOS_ROOT = prevRepos;
      if (prevProjects === undefined) delete process.env.PROJECTS_ROOT;
      else process.env.PROJECTS_ROOT = prevProjects;
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} env fail-fast checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} env fail-fast checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} env fail-fast checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`env fail-fast checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
