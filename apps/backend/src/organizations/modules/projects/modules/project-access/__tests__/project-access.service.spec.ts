/**
 * ProjectAccessService unit checks — self-contained runner (plain
 * node:assert, no Nest testing module, no live Postgres).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/organizations/modules/projects/modules/project-access/__tests__/project-access.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the org-only access contract with a fake DbService (the
 * select().from().where() shape only) and a fake OrganizationsGuard:
 * - (a) org-linked + member → resolves;
 * - (b) org-linked + non-member → 404 (no owner fallback);
 * - (c) org-linked + owner (not a member) → 404 (membership is the only rule);
 * - (d) org-less row (NULL org_id) → 404 for everyone (invalid row);
 * - (e) non-uuid requester on an org-linked project → 404, guard untouched
 *       (a non-uuid key can never match a uuid column — querying would 503);
 * - (f) assertProjectAccessById returns {ownerId, orgIds} and gates;
 * - (g) org-linked but org soft-deleted → 404;
 * - (h) resolveProjectDirectory: blank → 400 PROJECT_REQUIRED,
 *       stranger → 404, org-less → 404, member → {projectId, directory}
 *       inside the org jail, escaping path → 403.
 * - (i) projectAccessRow ECONNRESET (real DbService breaker+retry, stubbed
 *       drizzle edge): two transient failures then success (no restart);
 * - (j) projectAccessRow persistent ECONNRESET → 503 EXTERNAL_UNAVAILABLE
 *       after exactly 5 attempts (Retry-After 30 comes from the filter);
 * - (k) projectAccessRow non-retryable failure (22P02) → exactly 1 attempt.
 *
 * Logs are silent; no secrets or PII appear anywhere in this file.
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ExternalServiceError } from "@common/external/external-error";
import { DbService } from "@common/db/db.service";
import { WorkspacePathService } from "@common/storage/workspace-path.service";
import type { OrganizationsGuard } from "../../../../../organizations.guard";
import { ProjectAccessService } from "../project-access.service";

const ORG_ID = "123e4567-e89b-12d3-a456-426614174005";
const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174090";
const OWNER_ID = "123e4567-e89b-12d3-a456-426614174001";
const MEMBER_ID = "123e4567-e89b-12d3-a456-426614174002";
const STRANGER_ID = "123e4567-e89b-12d3-a456-426614174003";
/** Legacy mock key — not a uuid, so the membership lookup must be skipped. */
const NON_UUID_ID = "default";

type ProjectRow = { orgId: string | null; ownerId: string | null };

function silentLogger() {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as ConstructorParameters<typeof ProjectAccessService>[0];
}

/**
 * executeRead passthrough — runs the read once (no retry), like a closed breaker.
 */
function passthroughRead(
  _operation: string,
  read: (attempt: number) => Promise<unknown>,
): Promise<unknown> {
  return read(1);
}

/**
 * DbService stub for the only shape the gate uses:
 * `select({...}).from(projects).where(...)` → rows (no .limit()).
 */
function fakeDb(rows: Array<ProjectRow>) {
  const client = {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  };
  return {
    get client() {
      return client as never;
    },
    executeRead: passthroughRead,
  } as unknown as DbService;
}

/**
 * Fake guard — returns the configured role and counts getRole calls.
 * `deletedOrgs` models a soft-deleted organization: orgRowOrThrow → 404.
 */
function fakeGuard(
  roles: Record<string, string> = {},
  deletedOrgs: Array<string> = [],
) {
  const calls: Array<{ orgId: string; userId: string }> = [];
  const guard = {
    async getRole(orgId: string, userId: string): Promise<string | null> {
      calls.push({ orgId, userId });
      return roles[`${orgId}:${userId}`] ?? null;
    },
    async orgRowOrThrow(orgId: string) {
      if (deletedOrgs.includes(orgId)) {
        throw new NotFoundException(`Organization ${orgId} not found`);
      }
      return { id: orgId };
    },
  } as unknown as OrganizationsGuard;
  return { guard, calls };
}

function service(
  rows: Array<ProjectRow>,
  roles: Record<string, string> = {},
  deletedOrgs: Array<string> = [],
  paths: WorkspacePathService = new WorkspacePathService(),
) {
  const fake = fakeGuard(roles, deletedOrgs);
  const svc = new ProjectAccessService(
    silentLogger(),
    fakeDb(rows),
    fake.guard,
    paths,
  );
  return { svc, calls: fake.calls };
}

function isNotFound(err: unknown): boolean {
  return err instanceof NotFoundException;
}

const noSleep = (): Promise<void> => Promise.resolve();

/** pg transient-connection throw shaped like the node-postgres driver. */
function pgTransient(code: string): Error {
  return Object.assign(new Error(`read ${code}`), { code });
}

/**
 * select({orgId, ownerId}).from().where() following a script; repeats the
 * last step (the project-access shape has no .limit() — where() is awaited
 * directly).
 */
function flakyProjectDb(
  script: Array<{ error?: unknown; rows?: Array<ProjectRow> }>,
): { stub: unknown; getCalls: () => number } {
  let calls: number = 0;
  const stub: unknown = {
    select: () => ({
      from: () => ({
        where: async (): Promise<Array<ProjectRow>> => {
          calls += 1;
          const step: { error?: unknown; rows?: Array<ProjectRow> } =
            script[Math.min(calls - 1, script.length - 1)];
          if (step.error !== undefined) throw step.error;
          return step.rows ?? [];
        },
      }),
    }),
  };
  const getCalls: () => number = () => calls;
  return { stub, getCalls };
}

/**
 * REAL DbService (breaker + 5-attempt retry) with a stubbed drizzle client:
 * proves the gate delegates reads to executeRead. The pool stays null
 * (DATABASE_URL/POSTGRES_* cleared around construction, then restored) so no
 * socket is ever opened; the injected client answers the SQL edge.
 */
function makeResilientService(
  stubClient: unknown,
  roles: Record<string, string> = {},
): { service: ProjectAccessService; database: DbService } {
  const savedDatabaseUrl: string | undefined = process.env.DATABASE_URL;
  const savedUser: string | undefined = process.env.POSTGRES_USER;
  const savedDb: string | undefined = process.env.POSTGRES_DB;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_USER;
  delete process.env.POSTGRES_DB;
  try {
    const configStub = { get: (): undefined => undefined };
    const database: DbService = new DbService(
      configStub as never,
      silentLogger() as never,
    );
    Object.defineProperty(database, "client", {
      get: () => stubClient as never,
      configurable: true,
    });
    const fake = fakeGuard(roles);
    const service: ProjectAccessService = new ProjectAccessService(
      silentLogger(),
      database as never,
      fake.guard,
      new WorkspacePathService(),
    );
    return { service, database };
  } finally {
    if (savedDatabaseUrl !== undefined)
      process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedUser !== undefined) process.env.POSTGRES_USER = savedUser;
    if (savedDb !== undefined) process.env.POSTGRES_DB = savedDb;
  }
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "(a) org-linked + member → resolves",
    run: async () => {
      const { svc, calls } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }], {
        [`${ORG_ID}:${MEMBER_ID}`]: "user",
      });
      await svc.assertProjectAccess(PROJECT_ID, OWNER_ID, MEMBER_ID, "cid-a");
      assert.deepEqual(calls, [{ orgId: ORG_ID, userId: MEMBER_ID }]);
    },
  },
  {
    name: "(b) org-linked + non-member non-owner → 404",
    run: async () => {
      const { svc, calls } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }]);
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, STRANGER_ID, "cid-b"),
        (err: unknown) => {
          assert.ok(isNotFound(err), "stranger must get 404 (no existence leak)");
          assert.equal((err as Error).message, `Project ${PROJECT_ID} not found`);
          return true;
        },
      );
      // The membership lookup ran (uuid requester) and answered null.
      assert.deepEqual(calls, [{ orgId: ORG_ID, userId: STRANGER_ID }]);
    },
  },
  {
    name: "(c) org-linked + owner (not a member) → 404 (no owner fallback)",
    run: async () => {
      const { svc, calls } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }]);
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, OWNER_ID, "cid-c"),
        isNotFound,
      );
      // Member lookup answered null; the removed owner-equality fallback
      // no longer admits.
      assert.deepEqual(calls, [{ orgId: ORG_ID, userId: OWNER_ID }]);
    },
  },
  {
    name: "(d) org-less row → 404 for everyone (invalid row)",
    run: async () => {
      const { svc, calls } = service([{ orgId: null, ownerId: OWNER_ID }]);
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, OWNER_ID, "cid-d1"),
        isNotFound,
      );
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, STRANGER_ID, "cid-d2"),
        isNotFound,
      );
      assert.deepEqual(calls, [], "no org → no membership lookup, still denied");
    },
  },
  {
    name: "(e) non-uuid requester on an org-linked project → 404, guard not called",
    run: async () => {
      const { svc, calls } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }], {
        [`${ORG_ID}:${NON_UUID_ID}`]: "maintainer",
      });
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, NON_UUID_ID, "cid-e"),
        isNotFound,
      );
      assert.deepEqual(calls, [], "non-uuid keys never reach the membership query");
    },
  },
  {
    name: "(f) assertProjectAccessById returns {ownerId, orgIds} and gates",
    run: async () => {
      const { svc } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }], {
        [`${ORG_ID}:${MEMBER_ID}`]: "user",
      });
      assert.deepEqual(
        await svc.assertProjectAccessById(PROJECT_ID, MEMBER_ID, "cid-f1"),
        { ownerId: OWNER_ID, orgIds: [ORG_ID] },
      );
      // Org-less row → 404 even for the audit owner.
      const orgLess = service([{ orgId: null, ownerId: OWNER_ID }]);
      await assert.rejects(
        () => orgLess.svc.assertProjectAccessById(PROJECT_ID, OWNER_ID, "cid-f2"),
        isNotFound,
      );
      // Stranger → 404 before any owner/org leak.
      const { svc: gated } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }]);
      await assert.rejects(
        () => gated.assertProjectAccessById(PROJECT_ID, STRANGER_ID, "cid-f3"),
        isNotFound,
      );
      // Missing project row → 404 from projectAccessRow.
      const { svc: empty } = service([]);
      await assert.rejects(
        () => empty.assertProjectAccessById(PROJECT_ID, MEMBER_ID, "cid-f4"),
        (err: unknown) => {
          assert.ok(isNotFound(err));
          assert.equal((err as Error).message, `Project ${PROJECT_ID} not found`);
          return true;
        },
      );
      // orgIdsForProject reads the same 1:1 row / answers [] for org-less.
      assert.deepEqual(await svc.orgIdsForProject(PROJECT_ID, "cid-f5"), [ORG_ID]);
      assert.deepEqual(await orgLess.svc.orgIdsForProject(PROJECT_ID, "cid-f6"), []);
    },
  },
  {
    name: "(g) org-linked but org soft-deleted → 404",
    run: async () => {
      const { svc, calls } = service(
        [{ orgId: ORG_ID, ownerId: OWNER_ID }],
        { [`${ORG_ID}:${MEMBER_ID}`]: "user" },
        [ORG_ID],
      );
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, MEMBER_ID, "cid-g"),
        isNotFound,
      );
      void calls;
    },
  },
  {
    name: "(h) resolveProjectDirectory: blank → 400, stranger/org-less → 404, member → org jail dir, escape → 403",
    run: async () => {
      const previousRoot = process.env.REPOS_ROOT;
      process.env.REPOS_ROOT = "/tmp/opencode/c4-project-access-jail";
      try {
        const root = path.resolve(process.env.REPOS_ROOT);
        const { svc } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }], {
          [`${ORG_ID}:${MEMBER_ID}`]: "user",
        });

        // Blank (or absent) projectId → 400 PROJECT_REQUIRED before any gate.
        for (const blank of ["", "   ", undefined]) {
          await assert.rejects(
            () => svc.resolveProjectDirectory(blank, MEMBER_ID, "cid-h1"),
            (err: unknown) => {
              assert.ok(err instanceof BadRequestException);
              assert.deepEqual((err as BadRequestException).getResponse(), {
                code: "PROJECT_REQUIRED",
                message:
                  "projectId is required — session routes are project-scoped",
              });
              return true;
            },
          );
        }

        // Stranger → 404 (no existence leak).
        await assert.rejects(
          () => svc.resolveProjectDirectory(PROJECT_ID, STRANGER_ID, "cid-h2"),
          isNotFound,
        );

        // Member → the jailed org content dir for this project.
        assert.deepEqual(
          await svc.resolveProjectDirectory(PROJECT_ID, MEMBER_ID, "cid-h3"),
          {
            projectId: PROJECT_ID,
            directory: path.join(
              root,
              "orgs",
              ORG_ID,
              "projects",
              PROJECT_ID,
              "content",
            ),
          },
        );

        // Org-less row → 404 (project without an organization is invalid).
        const orgLess = service([{ orgId: null, ownerId: OWNER_ID }]);
        await assert.rejects(
          () => orgLess.svc.resolveProjectDirectory(PROJECT_ID, OWNER_ID, "cid-h4"),
          isNotFound,
        );

        // A resolved path outside the strict root → 403 from the real jail.
        const realPaths = new WorkspacePathService();
        const escaping = {
          async resolveOrgStrict() {
            return { absoluteRepo: path.resolve(root, "..", "escaped", "content") };
          },
          realStrictRoot: async () => root,
          assertInsideJail: (absolutePath: string, jail: string) =>
            realPaths.assertInsideJail(absolutePath, jail),
        } as unknown as WorkspacePathService;
        const memberRoles = { [`${ORG_ID}:${MEMBER_ID}`]: "user" };
        const { svc: escapingSvc } = service(
          [{ orgId: ORG_ID, ownerId: OWNER_ID }],
          memberRoles,
          [],
          escaping,
        );
        await assert.rejects(
          () =>
            escapingSvc.resolveProjectDirectory(PROJECT_ID, MEMBER_ID, "cid-h5"),
          (err: unknown) => err instanceof ForbiddenException,
        );
      } finally {
        if (previousRoot === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = previousRoot;
      }
    },
  },
  {
    name: "(i) projectAccessRow ECONNRESET retries then succeeds (recovery without restart)",
    run: async () => {
      const flaky = flakyProjectDb([
        { error: pgTransient("ECONNRESET") },
        { error: pgTransient("ECONNRESET") },
        { rows: [{ orgId: ORG_ID, ownerId: OWNER_ID }] },
      ]);
      const { service: resilient } = makeResilientService(flaky.stub);
      const row = await resilient.projectAccessRow(PROJECT_ID, "cid-r1", {
        jitter: false,
        sleep: noSleep,
      });
      assert.deepEqual(row, { orgId: ORG_ID, ownerId: OWNER_ID });
      assert.equal(flaky.getCalls(), 3);
    },
  },
  {
    name: "(j) projectAccessRow persistent ECONNRESET → 503 EXTERNAL_UNAVAILABLE (5 attempts, no crash)",
    run: async () => {
      const flaky = flakyProjectDb([{ error: pgTransient("ECONNRESET") }]);
      const { service: resilient } = makeResilientService(flaky.stub);
      await assert.rejects(
        () =>
          resilient.projectAccessRow(PROJECT_ID, "cid-r2", {
            jitter: false,
            sleep: noSleep,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ExternalServiceError);
          const typed: ExternalServiceError = error as ExternalServiceError;
          assert.equal(typed.code, "EXTERNAL_UNAVAILABLE");
          assert.equal(typed.service, "db");
          assert.equal(typed.httpStatus, 503);
          assert.equal(typed.isRetryable, true);
          return true;
        },
      );
      assert.equal(flaky.getCalls(), 5);
    },
  },
  {
    name: "(k) projectAccessRow non-retryable failure runs once then 503",
    run: async () => {
      const flaky = flakyProjectDb([
        {
          error: Object.assign(new Error("invalid input syntax"), {
            code: "22P02",
          }),
        },
      ]);
      const { service: resilient } = makeResilientService(flaky.stub);
      await assert.rejects(() =>
        resilient.projectAccessRow(PROJECT_ID, "cid-r3", {
          jitter: false,
          sleep: noSleep,
        }),
      );
      assert.equal(flaky.getCalls(), 1);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} project-access checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`${checks.length}/${checks.length} project-access checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`project-access checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
