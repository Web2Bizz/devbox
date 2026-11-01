/**
 * Repos e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist: `bun run build && bun dist/repos/repos.e2e.js`.
 *
 * Covers: GET /api/v1/repos lists only your own space (Bearer identity,
 * no-git + corrupted skipped, never 500), GET /api/v1/repos/:userSpace
 * per-space filtering (own space 200, foreign space 404 — 503 here since
 * the member gate needs PG and this suite runs without DB), invalid
 * userSpace → 400, anonymous → 401, POST /api/v1/repos → 404 (readonly:
 * GET only), missing root → 200 []. Never logs secrets; reports db 'down'
 * (strict Postgres).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Fixture BEFORE AppModule import (ConfigModule.validate at import reads REPOS_ROOT).
const REPOS_ROOT = mkdtempSync(path.join(tmpdir(), 'repos-e2e-'));
const E2E_UID = '123e4567-e89b-12d3-a456-426614174001';
const E2E_PID = '123e4567-e89b-12d3-a456-426614174002';
{
  const home = path.join(REPOS_ROOT, 'users', E2E_UID, 'projects');
  const valid = path.join(home, E2E_PID, 'content');
  mkdirSync(valid, { recursive: true });
  execFileSync('git', ['init', '-q', valid]);
  mkdirSync(path.join(home, '123e4567-e89b-12d3-a456-426614174003', 'content'), { recursive: true });
  const broken = path.join(home, '123e4567-e89b-12d3-a456-426614174004', 'content');
  mkdirSync(path.join(broken, '.git'), { recursive: true });
  writeFileSync(path.join(broken, '.git', 'HEAD'), 'garbage-not-a-ref\n');
  mkdirSync(path.join(REPOS_ROOT, 'users', 'lonely-scope'), { recursive: true });
}
process.env.REPOS_ROOT = REPOS_ROOT;

process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
process.env.OPENCODE_URL = 'http://127.0.0.1:9';
process.env.DATABASE_URL = '';
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST']) {
  delete process.env[key];
}
// Guarded readonly surface (C3): Bearer past JwtAuthGuard, own-space scope.
// No DB here — the foreign-space member gate denies 503 (same envelope).
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-not-real-0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-not-real-0123456789';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '7d';
process.env.AUTH_LEGACY_MOCK_FALLBACK = 'false';

async function main(): Promise<void> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app/app.module');
  const { configureApp } = await import('../app/app.setup');

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  const base = await app.getUrl();
  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      passed += 1;
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL - ${name}: ${(err as Error).message}`);
    }
  }

  const readJson = async (res: Response): Promise<unknown> =>
    (await res.json().catch(() => null)) as unknown;

  // Bearer caller = the fixture space owner (E2E_UID). Hand-signed
  // (TokenService.sign is pure, no DB — organizations unreachable pattern).
  const { TokenService } = await import('../users/auth/token.service');
  const tokens = app.get(TokenService, { strict: false }) as {
    sign: (
      claims: Record<string, unknown>,
      secret: string,
      ttlSec: number,
    ) => { token: string };
  };
  const bearer = tokens.sign(
    { sub: E2E_UID, email: 'probe@rush-code.local', typ: 'access' },
    process.env.JWT_ACCESS_SECRET as string,
    900,
  ).token;
  const auth = { headers: { authorization: `Bearer ${bearer}` } };

  try {
    await check('GET /api/v1/repos lists only the valid repo (own space)', async () => {
      const res = await fetch(`${base}/api/v1/repos`, auth);
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as Array<{ name?: string; path?: string }>;
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
      assert.equal(body[0].name, E2E_PID);
      assert.equal(body[0].path, `users/${E2E_UID}/projects/${E2E_PID}/content`);
    });

    await check('GET /api/v1/repos anon → 401', async () => {
      const res = await fetch(`${base}/api/v1/repos`);
      assert.equal(res.status, 401);
      assert.equal(((await readJson(res)) as { code?: string }).code, 'unauthorized');
    });

    await check('GET /api/v1/repos?q filters by name', async () => {
      const hit = await fetch(`${base}/api/v1/repos?q=DEM`, auth);
      assert.equal(hit.status, 200);
      assert.equal(((await readJson(hit)) as unknown[]).length, 1);
      const miss = await fetch(`${base}/api/v1/repos?q=zzz-nope`, auth);
      assert.equal(miss.status, 200);
      assert.deepEqual(await readJson(miss), []);
    });

    await check('GET /api/v1/repos/:userSpace scopes to one space', async () => {
      const res = await fetch(`${base}/api/v1/repos/${E2E_UID}`, auth);
      assert.equal(res.status, 200);
      assert.equal(((await readJson(res)) as unknown[]).length, 1);
      // Foreign space: the member gate needs PG — without DB it denies 503
      // (same EXTERNAL_UNAVAILABLE envelope); with DB a stranger gets 404.
      const empty = await fetch(`${base}/api/v1/repos/nobody-here`, auth);
      assert.equal(empty.status, 503);
      assert.equal(((await readJson(empty)) as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
    });

    await check('GET /api/v1/repos/:userSpace invalid chars → 400', async () => {
      const res = await fetch(`${base}/api/v1/repos/bad!space`, auth);
      assert.equal(res.status, 400);
    });

    await check('POST /api/v1/repos → 404 (readonly, GET only)', async () => {
      const res = await fetch(`${base}/api/v1/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 404);
    });

    await check('missing REPOS_ROOT → 200 [] (never 500)', async () => {
      process.env.REPOS_ROOT = path.join(REPOS_ROOT, 'definitely-missing-xyz');
      const res = await fetch(`${base}/api/v1/repos`, auth);
      assert.equal(res.status, 200);
      assert.deepEqual(await readJson(res), []);
    });
  } finally {
    await app.close();
  }

  console.log(`\nrepos e2e: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`repos e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
