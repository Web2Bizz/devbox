import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import {
  organizationMembers,
  organizations,
  projectChats,
  projectSessions,
  projects,
} from "@common/db/schema";
import { OrganizationsGuard } from "../organizations.guard";
import { OrganizationsService } from "../organizations.service";

type Case = { name: string; run: () => Promise<void> | void };
type Op = {
  kind: "select" | "insert" | "update" | "delete";
  table: unknown;
  values?: Record<string, unknown>;
  cond?: unknown;
};
type Row = Record<string, unknown>;

const cases: Array<Case> = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

const ORG_ID = "123e4567-e89b-12d3-a456-426614174005";
const USER_ID = "123e4567-e89b-12d3-a456-426614174001";
const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174090";

const ORG_ROW: Row = {
  id: ORG_ID,
  name: "rush",
  description: null,
  ownerId: USER_ID,
  isPrivate: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const MEMBER_ROW: Row = {
  id: "123e4567-e89b-12d3-a456-426614174010",
  orgId: ORG_ID,
  userId: USER_ID,
  role: "maintainer",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const PROJECT_ROW: Row = {
  id: PROJECT_ID,
  orgId: ORG_ID,
  name: "demo",
  description: null,
  githubOwner: null,
  githubRepo: null,
  githubBranch: null,
  githubUrl: null,
  ownerId: USER_ID,
  status: "active",
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const silentLogger = {
  debug() {},
  info() {},
  log() {},
  warn() {},
  error() {},
  fatal() {},
} as unknown as ConstructorParameters<typeof OrganizationsService>[0];

const pathsStub = {
  async orgScopeStrict() {
    return { absoluteHome: "/tmp/soft-delete-unused" };
  },
  async realStrictRoot() {
    return "/tmp";
  },
  async assertInsideJail() {},
  async removeDir() {},
} as unknown as ConstructorParameters<typeof OrganizationsService>[2];

function isColumn(node: Record<string, unknown>): boolean {
  return (
    typeof node.name === "string" &&
    typeof node.table === "object" &&
    node.table !== null
  );
}

function walk(
  node: unknown,
  onColumn: (name: string) => void,
  onValue: (value: unknown) => void,
): void {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (isColumn(obj)) {
      onColumn(obj.name as string);
      return;
    }
    if ("value" in obj && !Array.isArray(obj.value)) onValue(obj.value);
    for (const key of Object.keys(obj)) visit(obj[key]);
  };
  visit(node);
}

function referencedColumns(cond: unknown): Array<string> {
  const out: Array<string> = [];
  walk(
    cond,
    (name) => out.push(name),
    () => undefined,
  );
  return out;
}

function referencedValues(cond: unknown): Array<unknown> {
  const out: Array<unknown> = [];
  walk(
    cond,
    () => undefined,
    (value) => out.push(value),
  );
  return out;
}

function rowsResult(rows: Array<Row>) {
  const promise = Promise.resolve(rows);
  return {
    limit: (limit: number) => Promise.resolve(rows.slice(0, limit)),
    returning: () => Promise.resolve(rows),
    then: (
      onFulfilled?: (value: Array<Row>) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => promise.then(onFulfilled, onRejected),
  };
}

function makeDb(
  opts: {
    orgRows?: Array<Row>;
    memberRows?: Array<Row>;
    projectRows?: Array<Row>;
  } = {},
) {
  const state = {
    organizations: opts.orgRows ?? ([] as Array<Row>),
    organizationMembers: opts.memberRows ?? ([] as Array<Row>),
    projects: opts.projectRows ?? ([] as Array<Row>),
    projectChats: [] as Array<Row>,
    projectSessions: [] as Array<Row>,
  };
  const ops: Array<Op> = [];
  let transactions = 0;

  function rowsFor(table: unknown): Array<Row> {
    if (table === organizations) return state.organizations;
    if (table === organizationMembers) return state.organizationMembers;
    if (table === projects) return state.projects;
    if (table === projectChats) return state.projectChats;
    if (table === projectSessions) return state.projectSessions;
    return [];
  }

  function filterRows(table: unknown, rows: Array<Row>, cond: unknown): Array<Row> {
    if (cond === undefined || cond === null) return rows;
    const cols = referencedColumns(cond);
    const values = referencedValues(cond);
    const matches = (key: string, row: Row): boolean =>
      values.some((value) => value === row[key]);
    let out = rows;
    if (table === organizations && cols.includes("id")) {
      out = out.filter((row) => matches("id", row));
    }
    if (table === organizationMembers) {
      if (cols.includes("org_id")) out = out.filter((row) => matches("orgId", row));
      if (cols.includes("user_id")) out = out.filter((row) => matches("userId", row));
      if (cols.includes("role")) out = out.filter((row) => matches("role", row));
    }
    if (table === projects) {
      if (cols.includes("org_id")) out = out.filter((row) => matches("orgId", row));
      if (cols.includes("status")) out = out.filter((row) => matches("status", row));
    }
    if (cols.includes("deleted_at")) {
      out = out.filter((row) => row.deletedAt === null || row.deletedAt === undefined);
    }
    return out;
  }

  function selectBuilder(table: unknown) {
    let recorded = false;
    const joins: Array<unknown> = [];
    const resolve = (cond: unknown): Array<Row> => {
      if (!recorded) {
        ops.push({ kind: "select", table, cond });
        recorded = true;
      }
      let rows = rowsFor(table);
      // roleOf() joins organizations to require a live org: a member row whose
      // org carries deletedAt must disappear from the join result.
      for (const joinTable of joins) {
        if (joinTable === organizations) {
          rows = rows.filter((row) =>
            state.organizations.some(
              (org) =>
                org.id === row.orgId &&
                (org.deletedAt === null || org.deletedAt === undefined),
            ),
          );
        }
      }
      return filterRows(table, rows, cond).map((row) => ({ ...row }));
    };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.where = (cond: unknown) => rowsResult(resolve(cond));
    builder.limit = (limit: number) => Promise.resolve(resolve(undefined).slice(0, limit));
    builder.orderBy = chain;
    builder.groupBy = chain;
    builder.having = chain;
    builder.innerJoin = (joinTable: unknown) => {
      joins.push(joinTable);
      return builder;
    };
    builder.leftJoin = chain;
    builder.rightJoin = chain;
    builder.fullJoin = chain;
    return builder;
  }

  function updateBuilder(table: unknown) {
    return {
      set: (values: Record<string, unknown>) => {
        const apply = (cond: unknown): Array<Row> => {
          ops.push({ kind: "update", table, values, cond });
          const matched = filterRows(table, rowsFor(table), cond);
          for (const row of matched) Object.assign(row, values);
          return matched.map((row) => ({ ...row }));
        };
        return {
          where: (cond: unknown) => rowsResult(apply(cond)),
          returning: () => Promise.resolve(apply(undefined)),
          then: (
            onFulfilled?: (value: Array<Row>) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(apply(undefined)).then(onFulfilled, onRejected),
        };
      },
    };
  }

  function deleteBuilder(table: unknown) {
    ops.push({ kind: "delete", table });
    return { where: () => rowsResult([]) };
  }

  function insertBuilder(table: unknown) {
    return {
      values: (values: Record<string, unknown>) => {
        ops.push({ kind: "insert", table, values });
        const rows =
          table === organizations ? [{ ...ORG_ROW, ...values }] : [];
        return { returning: () => Promise.resolve(rows) };
      },
    };
  }

  const queries = {
    select: () => ({ from: (table: unknown) => selectBuilder(table) }),
    update: (table: unknown) => updateBuilder(table),
    delete: (table: unknown) => deleteBuilder(table),
    insert: (table: unknown) => insertBuilder(table),
  };

  const client = {
    ...queries,
    transaction: async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      transactions += 1;
      return cb(queries);
    },
  };

  return {
    client,
    ops,
    state,
    transactionCount: () => transactions,
  };
}

function makeService(
  db: unknown,
  guard?: unknown,
  paths: unknown = pathsStub,
): OrganizationsService {
  const serviceGuard =
    guard ??
    new OrganizationsGuard(
      silentLogger,
      db as unknown as ConstructorParameters<typeof OrganizationsGuard>[1],
    );
  return new OrganizationsService(
    silentLogger,
    db as unknown as ConstructorParameters<typeof OrganizationsService>[1],
    paths as unknown as ConstructorParameters<typeof OrganizationsService>[2],
    {} as unknown as ConstructorParameters<typeof OrganizationsService>[3],
    serviceGuard as unknown as ConstructorParameters<typeof OrganizationsService>[4],
    {} as unknown as ConstructorParameters<typeof OrganizationsService>[5],
    {} as unknown as ConstructorParameters<typeof OrganizationsService>[6],
  );
}

function makeGuard(db: unknown): OrganizationsGuard {
  return new OrganizationsGuard(
    silentLogger,
    db as unknown as ConstructorParameters<typeof OrganizationsGuard>[1],
  );
}

/** Paths stub that records removeDir calls (disk retention check). */
function trackingPaths() {
  const removeDirCalls: Array<string> = [];
  const paths = {
    async orgScopeStrict() {
      return { absoluteHome: "/tmp/soft-delete-org" };
    },
    async realStrictRoot() {
      return "/tmp";
    },
    async assertInsideJail() {},
    async removeDir(target: string) {
      removeDirCalls.push(target);
    },
  } as unknown as ConstructorParameters<typeof OrganizationsService>[2];
  return { paths, removeDirCalls };
}

/** Paths/users stubs for create() (disk-first, strict-root gate). */
function createStubs(opts: { diskFails?: boolean } = {}) {
  const paths = {
    checkUuid(value: string) {
      return value;
    },
    requireExplicitRoot() {},
    async ensureOrgScope() {
      if (opts.diskFails) throw new Error("mkdir failed");
    },
  } as unknown as ConstructorParameters<typeof OrganizationsService>[2];
  const users = {
    async findById() {
      return { id: USER_ID, email: "owner@example.com" };
    },
  } as unknown as ConstructorParameters<typeof OrganizationsService>[3];
  const guard = {
    async orgRowOrThrow() {
      return ORG_ROW;
    },
  } as unknown as ConstructorParameters<typeof OrganizationsService>[4];
  return { paths, users, guard };
}

const maintainerGuard = {
  async maintainerOrThrow() {
    return { org: ORG_ROW, role: "maintainer" };
  },
};

describe("OrganizationsService.remove soft delete", () => {
  it("never issues DELETE for organizations, projects, chats or sessions", async () => {
    const db = makeDb({ projectRows: [{ ...PROJECT_ROW }] });
    const svc = makeService(db, maintainerGuard);
    await svc.remove(ORG_ID, USER_ID, "cid-org-remove");
    assert.equal(
      db.ops.filter((op) => op.kind === "delete").length,
      0,
      "remove() must never issue a physical DELETE",
    );
    assert.equal(db.ops.filter((op) => op.kind === "insert").length, 0);
    assert.equal(db.ops.filter((op) => op.table === projectChats).length, 0);
    assert.equal(db.ops.filter((op) => op.table === projectSessions).length, 0);
  });

  it("marks the organization row with deletedAt", async () => {
    const db = makeDb({ projectRows: [{ ...PROJECT_ROW }] });
    const svc = makeService(db, maintainerGuard);
    await svc.remove(ORG_ID, USER_ID, "cid-org-remove");
    const orgUpdates = db.ops.filter(
      (op) => op.kind === "update" && op.table === organizations,
    );
    assert.equal(orgUpdates.length, 1, "organization must be updated once");
    assert.ok(
      orgUpdates[0].values?.deletedAt !== undefined &&
        orgUpdates[0].values?.deletedAt !== null,
      "organization.deleted_at must be set",
    );
  });

  it("keeps the organization home on disk (soft delete is reversible)", async () => {
    const db = makeDb({ projectRows: [{ ...PROJECT_ROW }] });
    const tracking = trackingPaths();
    const svc = makeService(db, maintainerGuard, tracking.paths);
    await svc.remove(ORG_ID, USER_ID, "cid-org-remove");
    assert.deepEqual(
      tracking.removeDirCalls,
      [],
      "remove() must not delete orgs/<orgId> from disk",
    );
  });

  it("cascades deletedAt onto the organization projects in one transaction", async () => {
    const db = makeDb({
      projectRows: [
        { ...PROJECT_ROW },
        {
          ...PROJECT_ROW,
          id: "123e4567-e89b-12d3-a456-426614174091",
          deletedAt: new Date("2026-01-02T00:00:00.000Z"),
          status: "deleted",
        },
      ],
    });
    const svc = makeService(db, maintainerGuard);
    await svc.remove(ORG_ID, USER_ID, "cid-org-remove");
    const projectUpdates = db.ops.filter(
      (op) => op.kind === "update" && op.table === projects,
    );
    assert.equal(projectUpdates.length, 1, "projects must be updated once");
    assert.ok(
      projectUpdates[0].values?.deletedAt !== undefined &&
        projectUpdates[0].values?.deletedAt !== null,
      "project.deleted_at must be set",
    );
    assert.ok(
      referencedColumns(projectUpdates[0].cond).includes("org_id"),
      "the project cascade must be scoped to the organization",
    );
    assert.ok(
      db.transactionCount() >= 1,
      "organization and projects must be updated in one transaction",
    );
  });
});

describe("OrganizationsService reads hide soft-deleted organizations", () => {
  it("get() rejects a soft-deleted organization with 404", async () => {
    const db = makeDb({
      orgRows: [
        { ...ORG_ROW, deletedAt: new Date("2026-01-02T00:00:00.000Z") },
      ],
      memberRows: [{ ...MEMBER_ROW }],
    });
    const svc = makeService(db);
    await assert.rejects(
      () => svc.get(ORG_ID, USER_ID, "cid-org-deleted"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundException);
        return true;
      },
    );
  });

  it("get() filters organizations.deleted_at in the query", async () => {
    const db = makeDb({
      orgRows: [
        { ...ORG_ROW, deletedAt: new Date("2026-01-02T00:00:00.000Z") },
      ],
      memberRows: [{ ...MEMBER_ROW }],
    });
    const svc = makeService(db);
    await svc.get(ORG_ID, USER_ID, "cid-org-deleted").catch(() => undefined);
    const orgSelects = db.ops.filter(
      (op) => op.kind === "select" && op.table === organizations,
    );
    assert.ok(orgSelects.length > 0);
    assert.ok(
      orgSelects.every((op) => referencedColumns(op.cond).includes("deleted_at")),
      "organization reads must constrain deleted_at",
    );
  });

  it("listForUser() drops soft-deleted organizations", async () => {
    const db = makeDb({
      orgRows: [
        { ...ORG_ROW, deletedAt: new Date("2026-01-02T00:00:00.000Z") },
      ],
      memberRows: [{ ...MEMBER_ROW }],
    });
    const svc = makeService(db);
    assert.deepEqual(await svc.listForUser(USER_ID, "cid-org-list"), []);
  });

  it("listForUser() filters organizations.deleted_at in the query", async () => {
    const db = makeDb({
      orgRows: [
        { ...ORG_ROW, deletedAt: new Date("2026-01-02T00:00:00.000Z") },
      ],
      memberRows: [{ ...MEMBER_ROW }],
    });
    const svc = makeService(db);
    await svc.listForUser(USER_ID, "cid-org-list");
    const orgSelects = db.ops.filter(
      (op) => op.kind === "select" && op.table === organizations,
    );
    assert.ok(orgSelects.length > 0);
    assert.ok(
      orgSelects.every((op) => referencedColumns(op.cond).includes("deleted_at")),
      "organization reads must constrain deleted_at",
    );
  });

  it("listForUser() still returns live organizations", async () => {
    const db = makeDb({
      orgRows: [{ ...ORG_ROW, deletedAt: null }],
      memberRows: [{ ...MEMBER_ROW }],
    });
    const svc = makeService(db);
    const out = await svc.listForUser(USER_ID, "cid-org-list");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, ORG_ID);
  });
});

describe("OrganizationsGuard denies membership in a soft-deleted organization", () => {
  it("getRole() returns null for a soft-deleted organization", async () => {
    const db = makeDb({
      orgRows: [
        { ...ORG_ROW, deletedAt: new Date("2026-01-02T00:00:00.000Z") },
      ],
      memberRows: [{ ...MEMBER_ROW }],
    });
    const guard = makeGuard(db);
    assert.equal(await guard.getRole(ORG_ID, USER_ID, "cid-org-role"), null);
  });

  it("memberRowOrThrow() rejects a soft-deleted organization with 404", async () => {
    const db = makeDb({
      orgRows: [
        { ...ORG_ROW, deletedAt: new Date("2026-01-02T00:00:00.000Z") },
      ],
      memberRows: [{ ...MEMBER_ROW }],
    });
    const guard = makeGuard(db);
    await assert.rejects(
      () => guard.memberRowOrThrow(ORG_ID, USER_ID, "cid-org-member"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundException);
        return true;
      },
    );
  });

  it("getRole() still returns the role for a live organization", async () => {
    const db = makeDb({
      orgRows: [{ ...ORG_ROW, deletedAt: null }],
      memberRows: [{ ...MEMBER_ROW }],
    });
    const guard = makeGuard(db);
    assert.equal(await guard.getRole(ORG_ID, USER_ID, "cid-org-role"), "maintainer");
  });
});

describe("OrganizationsService.create keeps rows on failure", () => {
  it("inserts org + owner membership in one transaction, no physical DELETE", async () => {
    const db = makeDb();
    const stubs = createStubs();
    const svc = new OrganizationsService(
      silentLogger,
      db as unknown as ConstructorParameters<typeof OrganizationsService>[1],
      stubs.paths,
      stubs.users,
      stubs.guard,
      {} as unknown as ConstructorParameters<typeof OrganizationsService>[5],
      {} as unknown as ConstructorParameters<typeof OrganizationsService>[6],
    );
    await svc.create({ name: "rush" }, USER_ID, "cid-org-create");
    assert.equal(db.transactionCount(), 1, "org + membership must share one transaction");
    assert.equal(db.ops.filter((op) => op.kind === "insert").length, 2);
    assert.equal(db.ops.filter((op) => op.kind === "delete").length, 0);
  });

  it("soft-deletes the org when disk init fails (no physical DELETE)", async () => {
    const db = makeDb();
    const stubs = createStubs({ diskFails: true });
    const svc = new OrganizationsService(
      silentLogger,
      db as unknown as ConstructorParameters<typeof OrganizationsService>[1],
      stubs.paths,
      stubs.users,
      stubs.guard,
      {} as unknown as ConstructorParameters<typeof OrganizationsService>[5],
      {} as unknown as ConstructorParameters<typeof OrganizationsService>[6],
    );
    await assert.rejects(() => svc.create({ name: "rush" }, USER_ID, "cid-org-create"));
    assert.equal(db.ops.filter((op) => op.kind === "delete").length, 0);
    const orgUpdates = db.ops.filter(
      (op) => op.kind === "update" && op.table === organizations,
    );
    assert.equal(orgUpdates.length, 1);
    assert.ok(
      orgUpdates[0].values?.deletedAt !== undefined &&
        orgUpdates[0].values?.deletedAt !== null,
      "the half-created org must be hidden by a soft delete",
    );
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(
    `organizations soft-delete checks failed to run: ${(err as Error).message}`,
  );
  process.exit(1);
});
