/**
 * ProjectAccessService unit checks — self-contained runner (plain
 * node:assert, no Nest testing module, no live Postgres).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/organizations/modules/projects/modules/project-access/__tests__/project-access.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * The gate moved here verbatim from the organizations service (Phase 4): the
 * projects domain owns the C4 rule and reads `projects.org_id` directly.
 * Covers the frozen access contract with a fake DbService (the
 * select().from().where() shape only) and a fake OrganizationsGuard:
 * - (a) org-linked + member → resolves;
 * - (b) org-linked + non-member non-owner → 404;
 * - (c) org-linked + owner (not a member) → resolves via owner fallback;
 * - (d) user-space owner → resolves;
 * - (e) user-space stranger → 404;
 * - (f) ownerless row → 404 for everyone (C5 deny-by-default);
 * - (g) non-uuid requester on an org-linked project → 404, guard untouched
 *       (a non-uuid key can never match a uuid column — querying would 503);
 * - (h) assertProjectAccessById returns {ownerId, orgIds} and gates;
 * - (i) org-linked + owner but org soft-deleted → 404 (no owner resurrection);
 * - (j) resolveProjectDirectory: blank projectId → 400 PROJECT_REQUIRED,
 *       stranger → 404, owner → {projectId, directory} inside the jail,
 *       escaping path → 403.
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
import type { DbService } from "../../../../../../common/db/db.service";
import { WorkspacePathService } from "../../../../../../common/storage/workspace-path.service";
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
    name: "(c) org-linked + owner (not a member) → resolves",
    run: async () => {
      const { svc, calls } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }]);
      await svc.assertProjectAccess(PROJECT_ID, OWNER_ID, OWNER_ID, "cid-c");
      // Member lookup answered null, owner-equality fallback admitted.
      assert.deepEqual(calls, [{ orgId: ORG_ID, userId: OWNER_ID }]);
    },
  },
  {
    name: "(d) user-space owner → resolves (guard untouched)",
    run: async () => {
      const { svc, calls } = service([{ orgId: null, ownerId: OWNER_ID }]);
      await svc.assertProjectAccess(PROJECT_ID, OWNER_ID, OWNER_ID, "cid-d");
      assert.deepEqual(calls, [], "no org → no membership lookup");
    },
  },
  {
    name: "(e) user-space stranger → 404",
    run: async () => {
      const { svc, calls } = service([{ orgId: null, ownerId: OWNER_ID }]);
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, STRANGER_ID, "cid-e"),
        isNotFound,
      );
      assert.deepEqual(calls, []);
    },
  },
  {
    name: "(f) ownerless row → 404 for everyone (C5 deny-by-default)",
    run: async () => {
      const { svc } = service([{ orgId: null, ownerId: null }]);
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, null, OWNER_ID, "cid-f1"),
        isNotFound,
      );
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, null, NON_UUID_ID, "cid-f2"),
        isNotFound,
      );
      // undefined owner behaves like null (legacy rows / absent column).
      await assert.rejects(
        () =>
          svc.assertProjectAccess(
            PROJECT_ID,
            undefined as unknown as null,
            OWNER_ID,
            "cid-f3",
          ),
        isNotFound,
      );
    },
  },
  {
    name: "(g) non-uuid requester on an org-linked project → 404, guard not called",
    run: async () => {
      const { svc, calls } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }], {
        [`${ORG_ID}:${NON_UUID_ID}`]: "maintainer",
      });
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, NON_UUID_ID, "cid-g"),
        isNotFound,
      );
      assert.deepEqual(calls, [], "non-uuid keys never reach the membership query");
    },
  },
  {
    name: "(h) assertProjectAccessById returns {ownerId, orgIds} and gates",
    run: async () => {
      const { svc } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }], {
        [`${ORG_ID}:${MEMBER_ID}`]: "user",
      });
      assert.deepEqual(
        await svc.assertProjectAccessById(PROJECT_ID, MEMBER_ID, "cid-h1"),
        { ownerId: OWNER_ID, orgIds: [ORG_ID] },
      );
      // Same row, user-space shape → empty orgIds, owner returned.
      const userSpace = service([{ orgId: null, ownerId: OWNER_ID }]);
      assert.deepEqual(
        await userSpace.svc.assertProjectAccessById(PROJECT_ID, OWNER_ID, "cid-h2"),
        { ownerId: OWNER_ID, orgIds: [] },
      );
      // Stranger → 404 before any owner/org leak.
      const { svc: gated } = service([{ orgId: ORG_ID, ownerId: OWNER_ID }]);
      await assert.rejects(
        () => gated.assertProjectAccessById(PROJECT_ID, STRANGER_ID, "cid-h3"),
        isNotFound,
      );
      // Missing project row → 404 from projectAccessRow.
      const { svc: empty } = service([]);
      await assert.rejects(
        () => empty.assertProjectAccessById(PROJECT_ID, MEMBER_ID, "cid-h4"),
        (err: unknown) => {
          assert.ok(isNotFound(err));
          assert.equal((err as Error).message, `Project ${PROJECT_ID} not found`);
          return true;
        },
      );
      // orgIdsForProject reads the same 1:1 row / answers [] for user-space.
      assert.deepEqual(await svc.orgIdsForProject(PROJECT_ID, "cid-h5"), [ORG_ID]);
      assert.deepEqual(await userSpace.svc.orgIdsForProject(PROJECT_ID, "cid-h6"), []);
    },
  },
  {
    name: "(i) org-linked + owner but org soft-deleted → 404",
    run: async () => {
      const { svc, calls } = service(
        [{ orgId: ORG_ID, ownerId: OWNER_ID }],
        {},
        [ORG_ID],
      );
      await assert.rejects(
        () => svc.assertProjectAccess(PROJECT_ID, OWNER_ID, OWNER_ID, "cid-i"),
        isNotFound,
      );
      // The member lookup still ran, but the owner fallback never rescued it.
      assert.deepEqual(calls, [{ orgId: ORG_ID, userId: OWNER_ID }]);
    },
  },
  {
    name: "(j) resolveProjectDirectory: blank → 400, stranger → 404, owner → jail dir, escape → 403",
    run: async () => {
      const previousRoot = process.env.REPOS_ROOT;
      process.env.REPOS_ROOT = "/tmp/opencode/c4-project-access-jail";
      try {
        const root = path.resolve(process.env.REPOS_ROOT);
        const { svc } = service([{ orgId: null, ownerId: OWNER_ID }]);

        // Blank (or absent) projectId → 400 PROJECT_REQUIRED before any gate.
        for (const blank of ["", "   ", undefined]) {
          await assert.rejects(
            () => svc.resolveProjectDirectory(blank, OWNER_ID, "cid-j1"),
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
          () => svc.resolveProjectDirectory(PROJECT_ID, STRANGER_ID, "cid-j2"),
          isNotFound,
        );

        // Owner → the jailed content dir for this project.
        assert.deepEqual(
          await svc.resolveProjectDirectory(PROJECT_ID, OWNER_ID, "cid-j3"),
          {
            projectId: PROJECT_ID,
            directory: path.join(
              root,
              "users",
              OWNER_ID,
              "projects",
              PROJECT_ID,
              "content",
            ),
          },
        );

        // A resolved path outside the strict root → 403 from the real jail.
        const realPaths = new WorkspacePathService();
        const escaping = {
          async resolveUserStrict() {
            return { absRepo: path.resolve(root, "..", "escaped", "content") };
          },
          realStrictRoot: async () => root,
          assertInsideJail: (abs: string, jail: string) =>
            realPaths.assertInsideJail(abs, jail),
        } as unknown as WorkspacePathService;
        const { svc: escapingSvc } = service(
          [{ orgId: null, ownerId: OWNER_ID }],
          {},
          [],
          escaping,
        );
        await assert.rejects(
          () =>
            escapingSvc.resolveProjectDirectory(PROJECT_ID, OWNER_ID, "cid-j4"),
          (err: unknown) => err instanceof ForbiddenException,
        );
      } finally {
        if (previousRoot === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = previousRoot;
      }
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
