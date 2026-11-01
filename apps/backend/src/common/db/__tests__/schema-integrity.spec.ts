import assert from "node:assert/strict";
import {
  auditMigrationMetadata,
  compareSchema,
  formatReport,
  getExpectedSchema,
  runSchemaIntegrityCheck,
} from "../schema-integrity";

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "detects missing or changed partial index predicate and non-exact columns",
    run: () => {
      const expected = getExpectedSchema().find((table) => table.name === "organization_members");
      assert.ok(expected);
      const index = expected.indexes.find(
        (candidate) => candidate.name === "organization_members_single_maintainer_idx",
      );
      assert.ok(index);
      assert.ok(index.predicate);
      const reportIndex = (candidate: {
        name: string;
        unique: boolean;
        predicate: string | null;
        columns: string[];
      }) =>
        compareSchema([expected], {
          tables: [{ name: expected.name, columns: expected.columns }],
          keys: [],
          foreignKeys: [],
          indexes: [
            {
              table: expected.name,
              name: candidate.name,
              columns: candidate.columns,
              unique: candidate.unique,
              keyColumnCount: candidate.columns.length,
              totalColumnCount: candidate.columns.length,
              predicate: candidate.predicate,
            },
          ],
        }).find((check) => check.name === `schema.index.${index.name}`);

      assert.equal(reportIndex({ ...index, predicate: null })?.status, "FAIL");
      assert.equal(
        reportIndex({ ...index, predicate: `${index.predicate} OR role = 'user'` })?.status,
        "FAIL",
      );
      assert.equal(
        reportIndex({
          ...index,
          columns: [...index.columns, "role"],
          predicate: index.predicate ?? null,
        })?.status,
        "FAIL",
      );
      assert.equal(
        reportIndex({ ...index, predicate: "(organization_members.role = 'maintainer'::text)" })?.status,
        "PASS",
      );
    },
  },
  {
    name: "detects missing foreign keys and indexes from string-array catalog data",
    run: () => {
      const expected = getExpectedSchema().find((table) => table.name === "organization_members");
      assert.ok(expected);
      const missingForeignKey = expected.foreignKeys[0];
      const missingIndex = expected.indexes[0];
      assert.ok(missingForeignKey);
      assert.ok(missingIndex);

      const actual = {
        tables: [{ name: expected.name, columns: [...expected.columns] }],
        keys: [],
        foreignKeys: expected.foreignKeys
          .filter((key) => key !== missingForeignKey)
          .map((key) => ({
            ...key,
            table: expected.name,
            columns: [...key.columns],
            foreignColumns: [...key.foreignColumns],
          })),
        indexes: expected.indexes
          .filter((index) => index !== missingIndex)
          .map((index) => ({
            ...index,
            table: expected.name,
            columns: [...index.columns],
            keyColumnCount: index.columns.length,
            totalColumnCount: index.columns.length,
            predicate: index.predicate ?? null,
          })),
      };

      assert.ok(Array.isArray(actual.tables[0]?.columns));
      assert.ok(actual.foreignKeys.every((key) => Array.isArray(key.columns) && Array.isArray(key.foreignColumns)));
      assert.ok(actual.indexes.every((index) => Array.isArray(index.columns)));
      const report = compareSchema([expected], actual);
      assert.equal(report.find((check) => check.name === `schema.foreign_keys.${expected.name}`)?.status, "FAIL");
      assert.equal(report.find((check) => check.name === `schema.index.${missingIndex.name}`)?.status, "FAIL");
    },
  },
  {
    name: "legacy projectsAndOrganizations stub is excluded",
    run: () => {
      assert.ok(!getExpectedSchema().some((table) => table.name === "projectsAndOrganizations"));
    },
  },
  {
    name: "missing migration journal or directory becomes a safe FAIL check",
    run: async () => {
      const result = await runSchemaIntegrityCheck("postgres://unused", {
        readMigrations: () => {
          throw new Error("ENOENT /private/path/_journal.json");
        },
        checkDatabase: async () => [],
      });
      const check = result.checks.find((item) => item.name === "migrations.metadata");
      assert.equal(check?.status, "FAIL");
      assert.doesNotMatch(formatReport(result.checks), /private|ENOENT/);
    },
  },
  {
    name: "missing DATABASE_URL fails without reading migrations or database",
    run: async () => {
      let touched = false;
      const result = await runSchemaIntegrityCheck(undefined, {
        readMigrations: () => {
          touched = true;
          return [];
        },
        checkDatabase: async () => {
          touched = true;
          return [];
        },
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.checks[0]?.name, "config.database_url");
      assert.equal(touched, false);
    },
  },
  {
    name: "detect missing required column from Drizzle schema",
    run: () => {
      const expected = getExpectedSchema().find((table) => table.name === "projects");
      assert.ok(expected);
      const actual = {
        tables: [
          {
            name: "projects",
            columns: expected.columns.filter((column) => column !== "org_id"),
          },
        ],
        keys: [],
        foreignKeys: [],
        indexes: [],
      };
      const report = compareSchema([expected], actual);
      const columns = report.find((check) => check.name === "schema.columns.projects");
      assert.equal(columns?.status, "FAIL");
      assert.match(columns?.detail ?? "", /org_id/);
    },
  },
  {
    name: "fail on empty journal while SQL migrations exist",
    run: () => {
      const report = auditMigrationMetadata(
        '{"version":"7","dialect":"postgresql","entries":[]}',
        ["0001_projects.sql"],
      );
      assert.equal(report.find((check) => check.name === "migrations.journal_entries")?.status, "FAIL");
      assert.equal(report.find((check) => check.name === "migrations.orphan_sql_files")?.status, "FAIL");
    },
  },
  {
    name: "fail on SQL migration orphaned from journal",
    run: () => {
      const journal = JSON.stringify({ entries: [{ tag: "0001_projects" }] });
      const report = auditMigrationMetadata(journal, ["0001_projects.sql", "0002_orphan.sql"]);
      const orphan = report.find((check) => check.name === "migrations.orphan_sql_files");
      assert.equal(orphan?.status, "FAIL");
      assert.match(orphan?.detail ?? "", /0002_orphan\.sql/);
    },
  },
  {
    name: "database failure report never includes URL or driver error message",
    run: async () => {
      const secretUrl = "postgres://private-user:private-password@private-host/db";
      const driverSecret = "password private-password at private-host";
      const result = await runSchemaIntegrityCheck(secretUrl, {
        readMigrations: () => [],
        checkDatabase: async () => {
          throw Object.assign(new Error(driverSecret), { code: "28P01" });
        },
      });
      const output = formatReport(result.checks);
      assert.ok(!output.includes(secretUrl));
      assert.ok(!output.includes("private-password"));
      assert.ok(!output.includes("private-host"));
      assert.ok(!output.includes(driverSecret));
      assert.match(output, /code=28P01/);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    throw new Error(`${failed}/${checks.length} schema integrity checks failed`);
  }
  console.log(`${checks.length}/${checks.length} schema integrity checks passed`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`schema integrity tests failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
