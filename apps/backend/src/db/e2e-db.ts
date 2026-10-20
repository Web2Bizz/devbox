/**
 * Shared e2e Postgres harness (strict-Postgres suites only: auth, projects,
 * github). Not imported by production code — e2e runners only.
 *
 * - `resolveTestDb(preferred)` — prefers TEST_DATABASE_URL (isolated PG,
 *   e.g. `docker run -p 5544:5432 -e POSTGRES_PASSWORD=... postgres:16`),
 *   falls back to DATABASE_URL. Probes reachability with a short budget:
 *   reachable → `{ mode: 'live', url }` (caller applies migrations and runs
 *   the full CRUD suite); otherwise → `{ mode: 'unreachable', url }`
 *   pointing at a dead port, and the caller must assert the strict-503
 *   surface (503 EXTERNAL_UNAVAILABLE + Retry-After 30 + correlationId)
 *   instead of silently passing. Never logs secrets (URLs carry
 *   credentials — only reachability outcomes are logged).
 * - `applyTestMigrations(url)` — applies drizzle/0001..0006 in order
 *   (idempotent IF NOT EXISTS) so the suite starts from a known schema.
 */
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { Pool } from "pg";

export type TestDbMode = "live" | "unreachable";

export type TestDb = {
  mode: TestDbMode;
  url: string;
};

/** Dead-port URL for 503-surface assertions (refused fast, no secrets). */
export const UNREACHABLE_TEST_DB_URL =
  "postgres://e2e:e2e@127.0.0.1:9/e2e_test";

/** True for explicit postgres://... URLs (shape check only, value never logged). */
export function isPostgresUrl(value: string): boolean {
  return /^postgres(ql)?:\/\/[^/\s]+/.test(value.trim());
}

async function canConnect(url: string, budgetMs = 4000): Promise<boolean> {
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: budgetMs,
  });
  try {
    const raced = await Promise.race([
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
  const url = preferredUrl.trim();
  if (url && isPostgresUrl(url) && (await canConnect(url))) {
    return { mode: "live", url };
  }
  return { mode: "unreachable", url: UNREACHABLE_TEST_DB_URL };
}

const MIGRATION_FILES = [
  "0001_projects.sql",
  "0002_github_installations.sql",
  "0003_users.sql",
  "0004_organizations.sql",
  "0005_user_opencode_keys.sql",
  "0006_user_opencode_keys_key_id.sql",
];

/** Locates apps/backend/drizzle from src/ or dist/ layouts (CJS __dirname). */
function drizzleDir(): string {
  return joinPath(__dirname, "..", "..", "drizzle");
}

/**
 * Applies drizzle/0001..0006 in file order (node-pg runs multi-statement
 * scripts in one query; files are IF NOT EXISTS idempotent).
 */
export async function applyTestMigrations(url: string): Promise<void> {
  const dir = drizzleDir();
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 8000,
  });
  try {
    for (const file of MIGRATION_FILES) {
      const sqlText = readFileSync(joinPath(dir, file), "utf8");
      await pool.query(sqlText);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}
