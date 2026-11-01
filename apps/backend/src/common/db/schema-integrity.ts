import { readFileSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { expand } from "dotenv-expand";
import * as dotenv from "dotenv";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  githubInstallations,
  organizationInvites,
  organizationMembers,
  organizations,
  projectChats,
  projects,
  projectSessions,
  userOpencodeKeys,
  users,
} from "./schema";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export type IntegrityCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
};

type ExpectedTable = {
  name: string;
  columns: string[];
  primaryKeys: string[][];
  foreignKeys: Array<{
    columns: string[];
    foreignTable: string;
    foreignColumns: string[];
    onDelete: string;
  }>;
  uniqueKeys: string[][];
  indexes: Array<{
    name: string;
    columns: string[];
    unique: boolean;
    predicate: string | null | undefined;
  }>;
};

type CatalogTable = {
  name: string;
  columns: string[];
};

type CatalogKey = {
  table: string;
  columns: string[];
  primary: boolean;
  unique: boolean;
  name: string;
};

type CatalogForeignKey = {
  table: string;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string;
};

type CatalogIndex = {
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
  keyColumnCount: number;
  totalColumnCount: number;
  predicate: string | null;
};

export type CatalogSnapshot = {
  tables: CatalogTable[];
  keys: CatalogKey[];
  foreignKeys: CatalogForeignKey[];
  indexes: CatalogIndex[];
};

const DRIZZLE_TABLES = [
  projects,
  projectChats,
  projectSessions,
  githubInstallations,
  users,
  userOpencodeKeys,
  organizations,
  organizationMembers,
  organizationInvites,
] as const;

const pgDialect = new PgDialect();

function normalizePredicate(predicate: string): string {
  let normalized = predicate.trim();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let i = 0; i < normalized.length - 1; i += 1) {
      if (normalized[i] === "(") depth += 1;
      if (normalized[i] === ")") depth -= 1;
      if (depth === 0) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression) break;
    normalized = normalized.slice(1, -1).trim();
  }
  let canonical = "";
  for (let i = 0; i < normalized.length; ) {
    const character = normalized[i];
    if (character === "'") {
      canonical += character;
      i += 1;
      while (i < normalized.length) {
        canonical += normalized[i];
        if (normalized[i] === "'" && normalized[i + 1] !== "'") {
          i += 1;
          break;
        }
        if (normalized[i] === "'" && normalized[i + 1] === "'") {
          canonical += normalized[i + 1];
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (character === '"') {
      let identifier = "";
      i += 1;
      while (i < normalized.length && normalized[i] !== '"') {
        identifier += normalized[i];
        i += 1;
      }
      i += 1;
      let next = i;
      while (next < normalized.length && /\s/.test(normalized[next])) next += 1;
      if (normalized[next] === ".") {
        i = next + 1;
        continue;
      }
      canonical += identifier;
      continue;
    }
    if (/\s/.test(character)) {
      i += 1;
      continue;
    }
    if (/[a-zA-Z_]/.test(character)) {
      const start = i;
      while (i < normalized.length && /[a-zA-Z0-9_$]/.test(normalized[i])) i += 1;
      const token = normalized.slice(start, i);
      let next = i;
      while (next < normalized.length && /\s/.test(normalized[next])) next += 1;
      if (normalized[next] === ".") {
        i = next + 1;
        continue;
      }
      canonical += token;
      continue;
    }
    if (normalized.slice(i, i + 6).toLowerCase() === "::text") {
      i += 6;
      continue;
    }
    canonical += character;
    i += 1;
  }
  return canonical;
}

/** The deprecated projectsAndOrganizations stub is deliberately excluded. */
export function getExpectedSchema(): ExpectedTable[] {
  return DRIZZLE_TABLES.map((table) => {
    const config = getTableConfig(table);
    const uniqueKeys = [
      ...config.uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name),
      ),
      ...config.columns
        .filter((column) => column.isUnique)
        .map((column) => [column.name]),
    ];
    const indexes = config.indexes.map((entry) => ({
      name: entry.config.name ?? "",
      columns: entry.config.columns.flatMap((column) =>
        "name" in column && typeof column.name === "string"
          ? [column.name]
          : [],
      ),
      unique: entry.config.unique,
      predicate: entry.config.where
        ? (() => {
            try {
              const query = pgDialect.sqlToQuery(entry.config.where);
              return query.params.length === 0 ? query.sql : undefined;
            } catch {
              return undefined;
            }
          })()
        : null,
    }));
    return {
      name: config.name,
      columns: config.columns.map((column) => column.name),
      primaryKeys: config.primaryKeys.map((key) =>
        key.columns.map((column) => column.name),
      ),
      foreignKeys: config.foreignKeys.map((key) => {
        const reference = key.reference();
        return {
          columns: reference.columns.map((column) => column.name),
          foreignTable: getTableConfig(reference.foreignTable).name,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onDelete: key.onDelete ?? "no action",
        };
      }),
      uniqueKeys,
      indexes,
    };
  });
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function sameColumns(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function sameKey(left: string[], right: string[]): boolean {
  return sameColumns(sorted(left), sorted(right));
}

function hasKey(
  keys: CatalogKey[],
  table: string,
  columns: string[],
  primary: boolean,
  unique: boolean,
): boolean {
  return keys.some(
    (key) =>
      key.table === table &&
      key.primary === primary &&
      key.unique === unique &&
      sameKey(key.columns, columns),
  );
}

export function compareSchema(
  expected: ExpectedTable[],
  actual: CatalogSnapshot,
): IntegrityCheck[] {
  const checks: IntegrityCheck[] = [];
  const actualTables = new Map(actual.tables.map((table) => [table.name, table]));

  for (const expectedTable of expected) {
    const table = actualTables.get(expectedTable.name);
    if (!table) {
      checks.push({
        name: `schema.table.${expectedTable.name}`,
        status: "FAIL",
        detail: "required table is missing",
      });
      continue;
    }

    const missingColumns = expectedTable.columns.filter(
      (column) => !table.columns.includes(column),
    );
    checks.push({
      name: `schema.columns.${expectedTable.name}`,
      status: missingColumns.length ? "FAIL" : "PASS",
      detail: missingColumns.length
        ? `missing: ${missingColumns.join(", ")}`
        : `${expectedTable.columns.length} required columns present`,
    });

    const missingPrimaryKeys = expectedTable.primaryKeys.filter(
      (columns) => !hasKey(actual.keys, expectedTable.name, columns, true, true),
    );
    checks.push({
      name: `schema.primary_keys.${expectedTable.name}`,
      status: missingPrimaryKeys.length ? "FAIL" : "PASS",
      detail: missingPrimaryKeys.length
        ? `missing: ${missingPrimaryKeys.map((key) => key.join("+")).join(", ")}`
        : "required primary keys present",
    });

    const missingForeignKeys = expectedTable.foreignKeys.filter(
      (expectedKey) =>
        !actual.foreignKeys.some(
          (key) =>
            key.table === expectedTable.name &&
            key.foreignTable === expectedKey.foreignTable &&
            key.onDelete === expectedKey.onDelete &&
            sameColumns(key.columns, expectedKey.columns) &&
            sameColumns(key.foreignColumns, expectedKey.foreignColumns),
        ),
    );
    checks.push({
      name: `schema.foreign_keys.${expectedTable.name}`,
      status: missingForeignKeys.length ? "FAIL" : "PASS",
      detail: missingForeignKeys.length
        ? `missing: ${missingForeignKeys
            .map((key) => `${key.columns.join("+")} -> ${key.foreignTable}.${key.foreignColumns.join("+")}`)
            .join(", ")}`
        : "required foreign keys present",
    });

    const missingUniqueKeys = expectedTable.uniqueKeys.filter(
      (columns) => !hasKey(actual.keys, expectedTable.name, columns, false, true),
    );
    checks.push({
      name: `schema.unique_keys.${expectedTable.name}`,
      status: missingUniqueKeys.length ? "FAIL" : "PASS",
      detail: missingUniqueKeys.length
        ? `missing: ${missingUniqueKeys.map((key) => key.join("+")).join(", ")}`
        : "required unique keys present",
    });

    for (const index of expectedTable.indexes) {
      const found = actual.indexes.some(
        (candidate) =>
          candidate.table === expectedTable.name &&
          candidate.name === index.name &&
          candidate.unique === index.unique &&
          sameColumns(candidate.columns, index.columns) &&
          candidate.keyColumnCount === index.columns.length &&
          candidate.totalColumnCount === index.columns.length &&
          index.predicate !== undefined &&
          (candidate.predicate === null) === (index.predicate === null) &&
          (index.predicate === null ||
            normalizePredicate(candidate.predicate ?? "") === normalizePredicate(index.predicate)),
      );
      checks.push({
        name: `schema.index.${index.name || expectedTable.name}`,
        status: found ? "PASS" : "FAIL",
        detail: found ? "required index present" : "required index is missing or mismatched",
      });
    }
  }
  return checks;
}

type Journal = {
  entries?: Array<{ tag?: unknown }>;
};

export function auditMigrationMetadata(
  journalContents: string,
  migrationFiles: string[],
): IntegrityCheck[] {
  let journal: Journal;
  try {
    journal = JSON.parse(journalContents) as Journal;
  } catch {
    return [
      {
        name: "migrations.journal",
        status: "FAIL",
        detail: "journal is not valid JSON",
      },
    ];
  }

  if (!Array.isArray(journal.entries)) {
    return [
      {
        name: "migrations.journal",
        status: "FAIL",
        detail: "journal entries are missing or invalid",
      },
    ];
  }

  const sqlFiles = migrationFiles.filter((file) => /^.+\.sql$/.test(file));
  const tags = journal.entries.map((entry) => entry.tag);
  const invalidTag = tags.some(
    (tag) => typeof tag !== "string" || !/^[A-Za-z0-9_-]+$/.test(tag),
  );
  if (invalidTag) {
    return [
      {
        name: "migrations.journal",
        status: "FAIL",
        detail: "journal contains an invalid migration tag",
      },
    ];
  }

  const duplicateTags = [...new Set(tags.filter((tag, i) => tags.indexOf(tag) !== i))] as string[];
  const missingFiles = [...new Set(tags as string[])].filter(
    (tag) => !sqlFiles.includes(`${tag}.sql`),
  );
  const journalFiles = new Set((tags as string[]).map((tag) => `${tag}.sql`));
  const orphanFiles = sqlFiles.filter((file) => !journalFiles.has(file));

  const emptyStatus: CheckStatus =
    tags.length === 0 && sqlFiles.length > 0 ? "FAIL" : "PASS";
  const checks: IntegrityCheck[] = [
    {
      name: "migrations.journal_entries",
      status: emptyStatus,
      detail:
        tags.length === 0 && sqlFiles.length > 0
          ? `journal is empty while ${sqlFiles.length} SQL migration file(s) exist; metadata was not modified`
          : `${tags.length} migration journal entr${tags.length === 1 ? "y" : "ies"}`,
    },
    {
      name: "migrations.journal_to_files",
      status:
        duplicateTags.length || missingFiles.length
          ? "FAIL"
          : "PASS",
      detail:
        duplicateTags.length || missingFiles.length
        ? [
              duplicateTags.length ? `duplicate tags: ${duplicateTags.join(", ")}` : "",
              missingFiles.length ? `missing SQL: ${missingFiles.map((tag) => `${tag}.sql`).join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; ")
          : "each journal tag maps to exactly one SQL file",
    },
    {
      name: "migrations.orphan_sql_files",
      status: orphanFiles.length ? "FAIL" : "PASS",
      detail: orphanFiles.length
        ? `not referenced by journal: ${orphanFiles.join(", ")}`
        : "no unjournaled SQL migration files",
    },
  ];
  return checks;
}

export function formatReport(checks: IntegrityCheck[]): string {
  const overall = checks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : checks.some((check) => check.status === "WARN")
      ? "WARN"
      : "PASS";
  return [
    `Database schema integrity: ${overall}`,
    ...checks.map((check) => `${check.status} ${check.name}: ${check.detail}`),
  ].join("\n");
}

// Migrations live at the backend root (apps/backend/drizzle): three levels up
// from both `src/common/db` and `dist/common/db` (file was moved out of
// `src/db` — keep this in sync with the source location).
const drizzleDir = joinPath(__dirname, "..", "..", "..", "drizzle");

function keyArray(row: QueryResultRow, field: string): string[] {
  const value: unknown = row[field];
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
}

async function readCatalog(client: PoolClient): Promise<CatalogSnapshot> {
  const tablesResult = await client.query<{ table_name: string; columns: string[] }>(`
    SELECT c.relname AS table_name,
           ARRAY(SELECT a.attname::text
                 FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum) AS columns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  `);
  const keysResult = await client.query<QueryResultRow>(`
    SELECT t.relname AS table_name, i.indisprimary AS is_primary,
           i.indisunique AS is_unique, ix.relname AS index_name,
            ARRAY(SELECT a.attname::text
                 FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                 WHERE k.ord <= i.indnkeyatts AND k.attnum <> 0
                 ORDER BY k.ord) AS columns
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class ix ON ix.oid = i.indexrelid
     WHERE n.nspname = 'public'
  `);
  const foreignResult = await client.query<QueryResultRow>(`
    SELECT source.relname AS table_name, target.relname AS foreign_table,
           c.confdeltype AS on_delete,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = source.oid AND a.attnum = k.attnum
                 ORDER BY k.ord) AS columns,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = target.oid AND a.attnum = k.attnum
                 ORDER BY k.ord) AS foreign_columns
    FROM pg_constraint c
    JOIN pg_class source ON source.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = source.relnamespace
    JOIN pg_class target ON target.oid = c.confrelid
     WHERE c.contype = 'f' AND n.nspname = 'public'
  `);
  const indexesResult = await client.query<QueryResultRow>(`
    SELECT t.relname AS table_name, ix.relname AS index_name,
            i.indisunique AS is_unique,
            i.indnkeyatts AS key_column_count, i.indnatts AS total_column_count,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            ARRAY(SELECT a.attname::text
                 FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                 WHERE k.ord <= i.indnkeyatts AND k.attnum <> 0
                 ORDER BY k.ord) AS columns
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class ix ON ix.oid = i.indexrelid
     WHERE n.nspname = 'public'
  `);

  const deleteActions: Record<string, string> = {
    a: "no action",
    r: "restrict",
    c: "cascade",
    n: "set null",
    d: "set default",
  };
  return {
    tables: tablesResult.rows.map((row) => ({
      name: row.table_name,
      columns: row.columns,
    })),
    keys: keysResult.rows.map((row) => ({
      table: row.table_name,
      columns: keyArray(row, "columns"),
      primary: row.is_primary,
      unique: row.is_unique,
      name: row.index_name,
    })),
    foreignKeys: foreignResult.rows.map((row) => ({
      table: row.table_name,
      columns: keyArray(row, "columns"),
      foreignTable: row.foreign_table,
      foreignColumns: keyArray(row, "foreign_columns"),
      onDelete: deleteActions[row.on_delete] ?? "unknown",
    })),
    indexes: indexesResult.rows.map((row) => ({
      table: row.table_name,
      name: row.index_name,
      columns: keyArray(row, "columns"),
      unique: row.is_unique,
      keyColumnCount: row.key_column_count,
      totalColumnCount: row.total_column_count,
      predicate: typeof row.predicate === "string" ? row.predicate : null,
    })),
  };
}

async function checkTarget(url: string): Promise<IntegrityCheck[]> {
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 8000,
    max: 1,
  });
  pool.on("error", () => undefined);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    const snapshot = await readCatalog(client);
    return compareSchema(getExpectedSchema(), snapshot);
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await pool.end().catch(() => undefined);
  }
}

function migrationChecks(): IntegrityCheck[] {
  const journalPath = joinPath(drizzleDir, "meta", "_journal.json");
  const journal = readFileSync(journalPath, "utf8");
  const migrationFiles = readdirSync(drizzleDir).filter((file) => file.endsWith(".sql"));
  return auditMigrationMetadata(journal, migrationFiles);
}

function migrationFailure(): IntegrityCheck {
  return {
    name: "migrations.metadata",
    status: "FAIL",
    detail: "migration journal or directory is unavailable",
  };
}

function safeErrorCode(error: unknown): string {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof candidate === "string" &&
    /^(?:[0-9A-Z]{5}|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET)$/.test(candidate)
    ? candidate
    : "connection_failed";
}

export async function runSchemaIntegrityCheck(
  databaseUrl: string | undefined,
  dependencies: {
    readMigrations?: () => IntegrityCheck[];
    checkDatabase?: (url: string) => Promise<IntegrityCheck[]>;
  } = {},
): Promise<{ checks: IntegrityCheck[]; exitCode: number }> {
  if (!databaseUrl?.trim()) {
    const checks: IntegrityCheck[] = [
      {
        name: "config.database_url",
        status: "FAIL",
        detail: "DATABASE_URL is required; set it in the environment",
      },
    ];
    return { checks, exitCode: 1 };
  }

  let checks: IntegrityCheck[];
  try {
    checks = (dependencies.readMigrations ?? migrationChecks)();
  } catch {
    checks = [migrationFailure()];
  }
  try {
    checks = [
      ...checks,
      ...(await (dependencies.checkDatabase ?? checkTarget)(databaseUrl.trim())),
    ];
  } catch (error) {
    checks = [
      ...checks,
      {
        name: "database.connection",
        status: "FAIL",
        detail: `catalog read failed (code=${safeErrorCode(error)})`,
      },
    ];
  }
  return {
    checks,
    exitCode: checks.some((check) => check.status === "FAIL") ? 1 : 0,
  };
}

if (require.main === module) {
  const dotenvResult = dotenv.config();
  expand(dotenvResult);
  void runSchemaIntegrityCheck(process.env.DATABASE_URL)
    .then(({ checks, exitCode }) => {
      console.log(formatReport(checks));
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error("Database schema integrity: FAIL\nFAIL checker.runtime: safe execution failure");
      process.exitCode = 1;
    });
}
