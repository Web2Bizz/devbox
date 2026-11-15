import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import {
  organizations,
  projectChats,
  projectSessions,
  projects,
} from "@common/db/schema";
import { ProjectsService } from "../projects.service";

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
const CLEAN_ID = "123e4567-e89b-12d3-a456-426614174090";
const SOFT_ID = "123e4567-e89b-12d3-a456-426614174091";
const CHAT_ID = "123e4567-e89b-12d3-a456-426614174092";
const SESSION_ID = "123e4567-e89b-12d3-a456-426614174093";

function orgRow(overrides: Row = {}): Row {
  return {
    id: ORG_ID,
    name: "rush",
    description: null,
    ownerId: USER_ID,
    isPrivate: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function projectRow(overrides: Row = {}): Row {
  return {
    id: CLEAN_ID,
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
    ...overrides,
  };
}

const silentLogger = {
  debug() {},
  info() {},
  log() {},
  warn() {},
  error() {},
  fatal() {},
} as unknown as ConstructorParameters<typeof ProjectsService>[0];

const pathsStub = {
  isExplicitRootConfigured: () => false,
} as unknown as ConstructorParameters<typeof ProjectsService>[2];

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
    projectRows?: Array<Row>;
    chatRows?: Array<Row>;
    sessionRows?: Array<Row>;
  } = {},
) {
  const state = {
    organizations: opts.orgRows ?? ([] as Array<Row>),
    projects: opts.projectRows ?? ([] as Array<Row>),
    projectChats: (opts.chatRows ?? []).map((row) => ({ ...row })),
    projectSessions: (opts.sessionRows ?? []).map((row) => ({ ...row })),
  };
  const ops: Array<Op> = [];
  let transactions = 0;

  function rowsFor(table: unknown): Array<Row> {
    if (table === organizations) return state.organizations;
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
    if (table === organizations) {
      if (cols.includes("id")) out = out.filter((row) => matches("id", row));
    }
    if (table === projects) {
      if (cols.includes("id")) out = out.filter((row) => matches("id", row));
      if (cols.includes("org_id")) out = out.filter((row) => matches("orgId", row));
      if (cols.includes("status")) out = out.filter((row) => matches("status", row));
      if (cols.includes("project_id")) {
        out = out.filter((row) => matches("projectId", row));
      }
    }
    if (cols.includes("deleted_at")) {
      out = out.filter((row) => row.deletedAt === null || row.deletedAt === undefined);
    }
    return out;
  }

  function selectBuilder(table: unknown) {
    let recorded = false;
    const resolve = (cond: unknown): Array<Row> => {
      if (!recorded) {
        ops.push({ kind: "select", table, cond });
        recorded = true;
      }
      return filterRows(table, rowsFor(table), cond).map((row) => ({ ...row }));
    };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.where = (cond: unknown) => rowsResult(resolve(cond));
    builder.limit = (limit: number) => Promise.resolve(resolve(undefined).slice(0, limit));
    builder.orderBy = chain;
    builder.groupBy = chain;
    builder.having = chain;
    builder.innerJoin = chain;
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
        return { returning: () => Promise.resolve([]) };
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

function makeService(db: unknown): ProjectsService {
  return new ProjectsService(
    silentLogger,
    db as unknown as ConstructorParameters<typeof ProjectsService>[1],
    pathsStub,
  );
}

function projectSelects(ops: Array<Op>) {
  return ops.filter((op) => op.kind === "select" && op.table === projects);
}

describe("ProjectsService.remove soft delete", () => {
  it("soft-deletes the project row and never issues DELETE", async () => {
    const db = makeDb({ projectRows: [projectRow()] });
    const svc = makeService(db);
    await svc.remove(CLEAN_ID, "cid-project-remove");
    assert.equal(
      db.ops.filter((op) => op.kind === "delete").length,
      0,
      "remove() must never issue a physical DELETE",
    );
    const updates = db.ops.filter(
      (op) => op.kind === "update" && op.table === projects,
    );
    assert.equal(updates.length, 1);
    assert.ok(
      updates[0].values?.deletedAt !== undefined &&
        updates[0].values?.deletedAt !== null,
      "project.deleted_at must be set",
    );
  });

  it("repeated remove() is a no-op and keeps the original deletedAt", async () => {
    const original = new Date("2026-01-02T00:00:00.000Z");
    const db = makeDb({
      projectRows: [projectRow({ status: "deleted", deletedAt: original })],
    });
    const svc = makeService(db);
    await svc.remove(CLEAN_ID, "cid-project-remove-again");
    assert.equal(
      db.ops.filter((op) => op.kind === "update").length,
      0,
      "a repeated DELETE must not re-stamp the row",
    );
    assert.equal(db.state.projects[0].deletedAt, original);
  });

  it("does not touch project_chats or project_sessions", async () => {
    const db = makeDb({
      projectRows: [projectRow()],
      chatRows: [{ id: CHAT_ID, projectId: CLEAN_ID, title: "chat" }],
      sessionRows: [{ id: SESSION_ID, projectId: CLEAN_ID, chatId: CHAT_ID }],
    });
    const svc = makeService(db);
    await svc.remove(CLEAN_ID, "cid-project-remove");
    assert.equal(db.ops.filter((op) => op.table === projectChats).length, 0);
    assert.equal(db.ops.filter((op) => op.table === projectSessions).length, 0);
  });
});

describe("ProjectsService reads hide soft-deleted projects", () => {
  it("list() hides projects with deletedAt set", async () => {
    const db = makeDb({
      projectRows: [
        projectRow(),
        projectRow({
          id: SOFT_ID,
          deletedAt: new Date("2026-01-02T00:00:00.000Z"),
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ],
    });
    const svc = makeService(db);
    const out = await svc.list("cid-project-list", { orgId: ORG_ID });
    assert.deepEqual(
      out.map((project) => project.id),
      [CLEAN_ID],
    );
  });

  it("list() filters projects.deleted_at in the query", async () => {
    const db = makeDb({ projectRows: [projectRow()] });
    const svc = makeService(db);
    await svc.list("cid-project-list", { orgId: ORG_ID });
    const selects = projectSelects(db.ops);
    assert.ok(selects.length > 0);
    assert.ok(
      selects.some((op) => referencedColumns(op.cond).includes("deleted_at")),
      "list() must constrain deleted_at",
    );
  });

  it("list({ includeDeleted: true }) still returns soft-deleted rows", async () => {
    const db = makeDb({
      projectRows: [
        projectRow(),
        projectRow({
          id: SOFT_ID,
          deletedAt: new Date("2026-01-02T00:00:00.000Z"),
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ],
    });
    const svc = makeService(db);
    const out = await svc.list("cid-project-list", {
      orgId: ORG_ID,
      includeDeleted: true,
    });
    assert.deepEqual(
      out.map((project) => project.id),
      [CLEAN_ID, SOFT_ID],
    );
  });

  it("getOrThrow() hides a row whose deletedAt is set even when status is active", async () => {
    const db = makeDb({
      projectRows: [
        projectRow({
          id: SOFT_ID,
          deletedAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ],
    });
    const svc = makeService(db);
    await assert.rejects(
      () => svc.getOrThrow(SOFT_ID, "cid-project-get"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundException);
        return true;
      },
    );
  });

  it("getOrThrow() filters projects.deleted_at in the query", async () => {
    const db = makeDb({ projectRows: [projectRow()] });
    const svc = makeService(db);
    const out = await svc.getOrThrow(CLEAN_ID, "cid-project-get");
    assert.equal(out.id, CLEAN_ID);
    const selects = projectSelects(db.ops);
    assert.ok(selects.length > 0);
    assert.ok(
      selects.some((op) => referencedColumns(op.cond).includes("deleted_at")),
      "getOrThrow() must constrain deleted_at",
    );
  });
});

describe("ProjectsService.restore keeps history", () => {
  it("revives the project without touching chats or sessions", async () => {
    const db = makeDb({
      orgRows: [orgRow()],
      projectRows: [
        projectRow({
          status: "deleted",
          deletedAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ],
      chatRows: [{ id: CHAT_ID, projectId: CLEAN_ID, title: "chat" }],
      sessionRows: [{ id: SESSION_ID, projectId: CLEAN_ID, chatId: CHAT_ID }],
    });
    const chatsBefore = db.state.projectChats.map((row) => ({ ...row }));
    const sessionsBefore = db.state.projectSessions.map((row) => ({ ...row }));
    const svc = makeService(db);
    const out = await svc.restore(CLEAN_ID, "cid-project-restore");
    assert.equal(out.id, CLEAN_ID);
    assert.equal(out.status, "active");
    assert.equal(out.deletedAt, null);
    assert.equal(db.ops.filter((op) => op.kind === "delete").length, 0);
    assert.equal(db.ops.filter((op) => op.table === projectChats).length, 0);
    assert.equal(db.ops.filter((op) => op.table === projectSessions).length, 0);
    assert.deepEqual(db.state.projectChats, chatsBefore);
    assert.deepEqual(db.state.projectSessions, sessionsBefore);
  });

  it("rejects a project whose organization is soft-deleted with 404 and keeps deletedAt", async () => {
    const deletedOrg = orgRow({
      deletedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const db = makeDb({
      orgRows: [deletedOrg],
      projectRows: [
        projectRow({
          status: "deleted",
          deletedAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ],
    });
    const svc = makeService(db);
    await assert.rejects(
      () => svc.restore(CLEAN_ID, "cid-project-restore-deleted-org"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundException);
        return true;
      },
    );
    assert.ok(
      db.state.projects[0].deletedAt instanceof Date,
      "restore must not clear deleted_at for a deleted org",
    );
    assert.equal(
      db.ops.filter((op) => op.kind === "update").length,
      0,
      "restore must not write the project row",
    );
  });

  it("restore filters organizations.deleted_at in the query", async () => {
    const db = makeDb({
      orgRows: [orgRow()],
      projectRows: [
        projectRow({
          status: "deleted",
          deletedAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ],
    });
    const svc = makeService(db);
    await svc.restore(CLEAN_ID, "cid-project-restore");
    const orgSelects = db.ops.filter(
      (op) => op.kind === "select" && op.table === organizations,
    );
    assert.ok(orgSelects.length > 0);
    assert.ok(
      orgSelects.every((op) => referencedColumns(op.cond).includes("deleted_at")),
      "restore must require a live organization",
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
    `projects soft-delete checks failed to run: ${(err as Error).message}`,
  );
  process.exit(1);
});
