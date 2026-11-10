/**
 * Shared e2e Postgres primitives (strict-Postgres suites: auth,
 * organizations, projects, github, keys). Not imported by production code.
 *
 * Suites do not call this module's URL resolution directly — they go through
 * `startTestDb()` in `e2e-db.container.ts`, which starts a throwaway
 * `postgres:16-alpine` container by default and applies migrations once.
 *
 * - `resolveTestDb(preferred)` — probed reachability (short budget) for the
 *   explicit `TEST_DATABASE_URL` override: reachable → `{ mode: 'live' }`,
 *   otherwise `{ mode: 'unreachable' }` pointing at a dead port. The container
 *   harness turns the unreachable outcome into a hard error (no silent 503
 *   fallback); `unreachable` remains only for the explicit
 *   `E2E_DB_MODE=unreachable` outage surface (503 EXTERNAL_UNAVAILABLE +
 *   Retry-After 30 + correlationId). Never logs secrets (URLs carry
 *   credentials — only reachability outcomes are logged).
 * - `applyTestMigrations(url)` — applies the active Drizzle migration set in
 *   drizzle so the suite starts from the code-first schema.
 */
import { join as joinPath } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

export type TestDbMode = "live" | "unreachable";

export type TestDb = {
  mode: TestDbMode;
  url: string;
};

/** Dead-port URL for 503-surface assertions (refused fast, no secrets). */
export const UNREACHABLE_TEST_DB_URL: string =
  "postgres://e2e:e2e@127.0.0.1:9/e2e_test";

/** True for explicit postgres://... URLs (shape check only, value never logged). */
export function isPostgresUrl(value: string): boolean {
  return /^postgres(ql)?:\/\/[^/\s]+/.test(value.trim());
}

async function canConnect(url: string, budgetMs: number = 4000): Promise<boolean> {
  const pool: Pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: budgetMs,
  });
  try {
    const raced: boolean = await Promise.race([
      pool.query("SELECT 1").then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), budgetMs),
      ),
    ]);
    return raced;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Resolves the e2e database: live PG when the preferred URL answers,
 * otherwise the dead-port URL for 503 assertions. Never throws on
 * connectivity — the mode carries the outcome.
 */
export async function resolveTestDb(preferredUrl: string): Promise<TestDb> {
  const url: string = preferredUrl.trim();
  if (url && isPostgresUrl(url) && (await canConnect(url))) {
    return { mode: "live", url };
  }
  return { mode: "unreachable", url: UNREACHABLE_TEST_DB_URL };
}

/**
 * Locates apps/backend/drizzle from src/ or dist/ layouts:
 * `<backend>/src/common/db` and `<backend>/dist/common/db` are both three
 * levels below the backend package root.
 */
function drizzleDir(): string {
  return joinPath(__dirname, "..", "..", "..", "drizzle");
}

/**
 * Applies the active drizzle migrations through Drizzle's migrator.
 */
export async function applyTestMigrations(url: string): Promise<void> {
  const directory: string = drizzleDir();
  const pool: Pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 8000,
  });
  try {
    const db: ReturnType<typeof drizzle> = drizzle(pool);
    await migrate(db, {
      migrationsFolder: directory,
      migrationsTable: "__drizzle_migrations_code_first",
      migrationsSchema: "drizzle",
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
