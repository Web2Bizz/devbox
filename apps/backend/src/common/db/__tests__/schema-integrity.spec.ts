import assert from "node:assert/strict";
import {
  auditMigrationMetadata,
  compareSchema,
  formatReport,
  getExpectedSchema,
  runSchemaIntegrityCheck,
  type CatalogSnapshot,
  type IntegrityCheck,
} from "../schema-integrity";

/** Expected-table shape is internal to the checker; derive it from the public API. */
type ExpectedTableShape = ReturnType<typeof getExpectedSchema>[number];
type ExpectedIndex = ExpectedTableShape["indexes"][number];
type ExpectedForeignKey = ExpectedTableShape["foreignKeys"][number];

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "detects missing or changed partial index predicate and non-exact columns",
    run: () => {
      const expected: ExpectedTableShape | undefined = getExpectedSchema().find(
        (table) => table.name === "organization_members",
      );
      assert.ok(expected);
      const index: ExpectedIndex | undefined =
        expected.indexes.find(
          (candidate) => candidate.name === "organization_members_single_maintainer_idx",
        );
      assert.ok(index);
      assert.ok(index.predicate);
      const reportIndex: (candidate: {
        name: string;
        unique: boolean;
        predicate: string | null;
        columns: Array<string>;
      }) => IntegrityCheck | undefined = (candidate: {
        name: string;
        unique: boolean;
        predicate: string | null;
        columns: Array<string>;
      }): IntegrityCheck | undefined =>
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
      const expected: ExpectedTableShape | undefined = getExpectedSchema().find(
        (table) => table.name === "organization_members",
      );
      assert.ok(expected);
      const missingForeignKey: ExpectedForeignKey | undefined =
        expected.foreignKeys[0];
      const missingIndex: ExpectedIndex | undefined =
        expected.indexes[0];
      assert.ok(missingForeignKey);
      assert.ok(missingIndex);

      const actual: CatalogSnapshot = {
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
      const report: Array<IntegrityCheck> = compareSchema([expected], actual);
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
      const result: Awaited<ReturnType<typeof runSchemaIntegrityCheck>> =
        await runSchemaIntegrityCheck("postgres://unused", {
          readMigrations: () => {
            throw new Error("ENOENT /private/path/_journal.json");
          },
          checkDatabase: async () => [],
        });
      const check: IntegrityCheck | undefined = result.checks.find(
        (item) => item.name === "migrations.metadata",
      );
      assert.equal(check?.status, "FAIL");
      assert.doesNotMatch(formatReport(result.checks), /private|ENOENT/);
    },
  },
  {
    name: "missing DATABASE_URL fails without reading migrations or database",
    run: async () => {
      let touched: boolean = false;
      const result: Awaited<ReturnType<typeof runSchemaIntegrityCheck>> =
        await runSchemaIntegrityCheck(undefined, {
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
      const expected: ExpectedTableShape | undefined = getExpectedSchema().find(
        (table) => table.name === "projects",
      );
      assert.ok(expected);
      const actual: CatalogSnapshot = {
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
      const report: Array<IntegrityCheck> = compareSchema([expected], actual);
      const columns: IntegrityCheck | undefined = report.find(
        (check) => check.name === "schema.columns.projects",
      );
      assert.equal(columns?.status, "FAIL");
      assert.match(columns?.detail ?? "", /org_id/);
    },
  },
  {
    name: "fail on empty journal while SQL migrations exist",
    run: () => {
      const report: Array<IntegrityCheck> = auditMigrationMetadata(
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
      const journal: string = JSON.stringify({ entries: [{ tag: "0001_projects" }] });
      const report: Array<IntegrityCheck> = auditMigrationMetadata(journal, [
        "0001_projects.sql",
        "0002_orphan.sql",
      ]);
      const orphan: IntegrityCheck | undefined = report.find(
        (check) => check.name === "migrations.orphan_sql_files",
      );
      assert.equal(orphan?.status, "FAIL");
      assert.match(orphan?.detail ?? "", /0002_orphan\.sql/);
    },
  },
  {
    name: "database failure report never includes URL or driver error message",
    run: async () => {
      const secretUrl: string = "postgres://private-user:private-password@private-host/db";
      const driverSecret: string = "password private-password at private-host";
      const result: Awaited<ReturnType<typeof runSchemaIntegrityCheck>> =
        await runSchemaIntegrityCheck(secretUrl, {
          readMigrations: () => [],
          checkDatabase: async () => {
            throw Object.assign(new Error(driverSecret), { code: "28P01" });
          },
        });
      const output: string = formatReport(result.checks);
      assert.ok(!output.includes(secretUrl));
      assert.ok(!output.includes("private-password"));
      assert.ok(!output.includes("private-host"));
      assert.ok(!output.includes(driverSecret));
      assert.match(output, /code=28P01/);
    },
  },
];

async function main(): Promise<void> {
  let failed: number = 0;
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
