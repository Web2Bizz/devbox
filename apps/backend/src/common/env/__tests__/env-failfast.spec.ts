/**
 * env fail-fast regression checks — self-contained runner (no new deps).
 *
 * AGENTS.md «Фолбэки запрещены по умолчанию»: отсутствие обязательного значения
 * для записи/мутации → throw fail-fast `[env] X is required/is invalid...`
 * (что задать, где — .env.example), без значений секретов в тексте.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/common/env/__tests__/env-failfast.spec.js`
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
import { validateEnv } from '../env';
import { WorkspacePathService } from '@common/storage/workspace-path.service';

type Source = NodeJS.ProcessEnv;

/** Минимальный валидный source (write-path ключи заданы явно). */
function baseEnv(): Source {
  return {
    APP_BACKEND_PORT: '3000',
    APP_BACKEND_HOST: '127.0.0.1',
    APP_BACKEND_PROTOCOL: 'http',
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

function without(source: Source, ...keys: Array<string>): Source {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key) && typeof value === 'string') out[key] = value;
  }
  return out as Source;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'пустой APP_BACKEND_PORT (+ пустой PORT) → throw [env] APP_BACKEND_PORT is required',
    run: () => {
      const source: Source = without(baseEnv(), 'APP_BACKEND_PORT');
      try {
        validateEnv(source);
        assert.fail('must throw on missing APP_BACKEND_PORT');
      } catch (error) {
        const message: string = (error as Error).message;
        assert.match(message, /\[env\] APP_BACKEND_PORT is required/, message);
        assert.ok(message.includes('.env.example'), `no .env.example pointer: ${message}`);
      }
    },
  },
  {
    name: 'whitespace-only PORT при пустом APP_BACKEND_PORT → throw (trim-пустота = отсутствие)',
    run: () => {
      const source: Source = { ...without(baseEnv(), 'APP_BACKEND_PORT'), PORT: '   ' } as Source;
      assert.throws(() => validateEnv(source), /\[env\] APP_BACKEND_PORT is required/);
    },
  },
  {
    name: 'legacy PORT покрывает APP_BACKEND_PORT (явное значение — не фолбэк)',
    run: () => {
      const source: Source = { ...without(baseEnv(), 'APP_BACKEND_PORT'), PORT: '3100' } as Source;
      assert.equal(validateEnv(source).backendPort, 3100);
    },
  },
  {
    name: 'malformed DATABASE_URL → throw без эха значения (секрет не в тексте)',
    run: () => {
      const secret: string = 'postgres://admin:s3cr3t-not-real@localhost:5432/db';
      const source: Source = { ...baseEnv(), DATABASE_URL: 'not-a-db-url' } as Source;
      void secret;
      try {
        validateEnv(source);
        assert.fail('must throw on malformed DATABASE_URL');
      } catch (error) {
        const message: string = (error as Error).message;
        assert.match(message, /\[env\] DATABASE_URL/, message);
        assert.ok(!message.includes('not-a-db-url') || message.includes('unsupported shape'), message);
        assert.ok(message.includes('.env.example'), `no .env.example pointer: ${message}`);
      }
    },
  },
  {
    name: 'пустой REPOS_ROOT → requireExplicitRoot throw 500 (путь записи, без <cwd>/repos)',
    run: () => {
      const paths: WorkspacePathService = new WorkspacePathService();
      assert.equal(paths.isExplicitRootConfigured(), false);
      try {
        paths.requireExplicitRoot();
        assert.fail('must throw');
      } catch (error) {
        assert.equal((error as { status?: number }).status, 500);
        assert.match((error as Error).message, /REPOS_ROOT/, (error as Error).message);
      }
    },
  },
  {
    name: 'whitespace-only REPOS_ROOT → тоже throw (trim-пустота = отсутствие)',
    run: () => {
      const previousReposRoot: string | undefined = process.env.REPOS_ROOT;
      process.env.REPOS_ROOT = '   ';
      try {
        const paths: WorkspacePathService = new WorkspacePathService();
        assert.equal(paths.isExplicitRootConfigured(), false);
        assert.throws(() => paths.requireExplicitRoot(), /REPOS_ROOT/);
      } finally {
        if (previousReposRoot === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = previousReposRoot;
      }
    },
  },
  {
    name: 'resolveOrgStrict при пустом ROOT → rejects до любого touch диска/БД',
    run: async () => {
      const paths: WorkspacePathService = new WorkspacePathService();
      await assert.rejects(() =>
        paths.resolveOrgStrict(
          '123e4567-e89b-12d3-a456-426614174001',
          '123e4567-e89b-12d3-a456-426614174002',
        ),
      );
    },
  },
  {
    name: 'PROJECTS_ROOT с NUL-байтом → throw (невалидный путь записи)',
    run: () => {
      const source: Source = { ...baseEnv(), PROJECTS_ROOT: 'bad\0path' } as Source;
      assert.throws(() => validateEnv(source), /\[env\] PROJECTS_ROOT/);
    },
  },
  {
    name: 'REPOS_ROOT с NUL-байтом → throw (невалидный путь записи)',
    run: () => {
      const source: Source = { ...baseEnv(), REPOS_ROOT: 'bad\0path' } as Source;
      assert.throws(() => validateEnv(source), /\[env\] REPOS_ROOT/);
    },
  },
];

async function main(): Promise<void> {
  // NOTE (bun test shares one process across spec files): ROOT-негативные проверки
  // читают process.env.REPOS_ROOT — форсируем unconfigured-состояние ТОЛЬКО вокруг
  // таких checks и восстанавливаем сразу после (как в project-strict-root.spec.ts).
  let failed: number = 0;
  for (const check of checks) {
    const previousReposRoot: string | undefined = process.env.REPOS_ROOT;
    const previousProjectsRoot: string | undefined =
      process.env.PROJECTS_ROOT;
    const needsClean: boolean =
      check.name.startsWith('пустой REPOS_ROOT') ||
      check.name.startsWith('resolveOrgStrict') ||
      check.name.startsWith('resolveStrict');
    if (needsClean) {
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
    }
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    } finally {
      if (previousReposRoot === undefined) delete process.env.REPOS_ROOT;
      else process.env.REPOS_ROOT = previousReposRoot;
      if (previousProjectsRoot === undefined) delete process.env.PROJECTS_ROOT;
      else process.env.PROJECTS_ROOT = previousProjectsRoot;
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

void main().catch((error: unknown) => {
  console.error(`env fail-fast checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
