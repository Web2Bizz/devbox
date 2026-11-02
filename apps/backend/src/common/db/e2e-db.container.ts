/**
 * Testcontainers-backed Postgres for e2e runners (strict-Postgres suites:
 * auth, organizations, projects, github, keys). Not imported by production
 * code.
 *
 * Default: starts a throwaway `postgres:16-alpine` container, applies the
 * drizzle migration set through `applyTestMigrations`, and stops the
 * container when the suite calls `stop()` (Ryuk reaps it on abnormal exit).
 *
 * Overrides:
 * - `TEST_DATABASE_URL` — use an already running Postgres instead of docker
 *   (CI or a local instance). Unreachable override fails loud, never
 *   silently falls back to the outage surface.
 * - `E2E_DB_MODE=unreachable` — explicit opt-in for the 503-surface branch
 *   used by the outage checks; never the default.
 */
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

import {
  UNREACHABLE_TEST_DB_URL,
  applyTestMigrations,
  isPostgresUrl,
  resolveTestDb,
  type TestDbMode,
} from "./e2e-db";

export const E2E_DB_IMAGE = "postgres:16-alpine";

const E2E_DB_NAME = "rush_code_e2e";
const E2E_DB_USER = "rush_code";
const E2E_DB_PASSWORD = "rush_code";
const STARTUP_TIMEOUT_MS = 120_000;

export type E2eTestDb = {
  mode: TestDbMode;
  url: string;
  /** Stops the container (no-op for overrides and unreachable mode). */
  stop: () => Promise<void>;
};

const noop = async (): Promise<void> => undefined;

async function startContainer(): Promise<StartedPostgreSqlContainer> {
  try {
    return await new PostgreSqlContainer(E2E_DB_IMAGE)
      .withDatabase(E2E_DB_NAME)
      .withUsername(E2E_DB_USER)
      .withPassword(E2E_DB_PASSWORD)
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `e2e: cannot start ${E2E_DB_IMAGE} via testcontainers — is Docker running? ` +
        `Set TEST_DATABASE_URL to reuse an existing Postgres. Cause: ${reason}`,
    );
  }
}

/**
 * Resolves the e2e database and applies migrations once per container.
 */
export async function startTestDb(): Promise<E2eTestDb> {
  if (process.env.E2E_DB_MODE === "unreachable") {
    return { mode: "unreachable", url: UNREACHABLE_TEST_DB_URL, stop: noop };
  }

  const external = (process.env.TEST_DATABASE_URL ?? "").trim();
  if (external) {
    if (!isPostgresUrl(external)) {
      throw new Error(
        "e2e: TEST_DATABASE_URL must be a postgres:// URL (value never logged)",
      );
    }
    const resolved = await resolveTestDb(external);
    if (resolved.mode !== "live") {
      throw new Error(
        "e2e: TEST_DATABASE_URL is set but not reachable — start that database or unset the variable",
      );
    }
    await applyTestMigrations(resolved.url);
    return { mode: "live", url: resolved.url, stop: noop };
  }

  const container = await startContainer();
  const url = container.getConnectionUri();
  try {
    await applyTestMigrations(url);
  } catch (err) {
    await container.stop().catch(() => undefined);
    throw err;
  }
  return {
    mode: "live",
    url,
    stop: async () => {
      await container.stop().catch(() => undefined);
    },
  };
}
