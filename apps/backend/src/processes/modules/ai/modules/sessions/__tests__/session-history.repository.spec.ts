import assert from "node:assert/strict";
import {
  projectSessions,
  sessionAgents,
  sessionMessages,
} from "@common/db/schema";
import type { AppLogger } from "@common/logger";
import { SessionHistoryRepository, orderByParentChain } from "../session-history.repository";

/**
 * Fake-drizzle checks for SessionHistoryRepository: mapping/filters only.
 * The fake mirrors the exact chains the repository issues (select …
 * where … orderBy/limit, leftJoin, insert … onConflict*, update … set …
 * where) and records the ops it saw, same convention as the organizations
 * soft-delete spec.
 */
type Case = { name: string; run: () => Promise<void> | void };
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

const UID = "123e4567-e89b-12d3-a456-426614174001";
const PID = "123e4567-e89b-12d3-a456-426614174090";
const HARNESS_ID = "0190a0b0-0000-7000-8000-000000000001";

function silentLogger(): AppLogger {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as AppLogger;
}

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
    if ("value" in obj && Array.isArray(obj.value)) {
      for (const item of obj.value as Array<unknown>) onValue(item);
    }
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

/**
 * Order term of the fake `orderBy`: drizzle wraps `asc(col)`/`desc(col)` in an
 * SQL node whose column is reachable by the same walker the filters use; the
 * direction lives in a raw string chunk (" desc"). Defaults to ascending so
 * pre-existing `orderBy(asc(createdAt))` chains keep their old behaviour.
 */
type OrderTerm = { column: string; direction: 1 | -1 };

function isDescOrder(node: unknown): boolean {
  let desc = false;
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (/\bdesc\b/i.test(value)) desc = true;
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isColumn(value as Record<string, unknown>)) return;
    for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  };
  visit(node);
  return desc;
}

function orderTerms(args: Array<unknown>): Array<OrderTerm> {
  return args.map((arg) => ({
    column: referencedColumns(arg)[0] ?? "createdAt",
    direction: isDescOrder(arg) ? -1 : 1,
  }));
}

/** Column name → row key used by the fake state (updated_at → updatedAt). */
function rowKey(column: string): string {
  return column.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function timeValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return new Date(value).getTime();
  return 0;
}

type State = {
  sessionMessages: Array<Row>;
  sessionAgents: Array<Row>;
  projectSessions: Array<Row>;
};

function isLive(row: Row): boolean {
  return row.deletedAt === null || row.deletedAt === undefined;
}

function makeDb(seed: Partial<State> = {}) {
  const state: State = {
    sessionMessages: seed.sessionMessages ?? [],
    sessionAgents: seed.sessionAgents ?? [],
    projectSessions: seed.projectSessions ?? [],
  };
  const ops: Array<{
    kind: "select" | "insert" | "update";
    table: unknown;
    values?: Record<string, unknown>;
    conflict?: string;
    cond?: unknown;
  }> = [];

  function rowsFor(table: unknown): Array<Row> {
    if (table === sessionMessages) return state.sessionMessages;
    if (table === sessionAgents) return state.sessionAgents;
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
    if (table === sessionMessages) {
      // 0010: surrogate uuid PK (row "id") + UNIQUE(domain_id). Reads filter
      // on the domain id; the surrogate never appears in a WHERE.
      if (cols.includes("domain_id")) out = out.filter((row) => matches("domainId", row));
      if (cols.includes("id")) out = out.filter((row) => matches("domainId", row));
      if (cols.includes("session_id")) out = out.filter((row) => matches("sessionId", row));
      // Chain 0009: no project_id on messages — project scope is the JOIN
      // with project_sessions (handled in selectBuilder), never a column.
      if (cols.includes("deleted_at")) out = out.filter(isLive);
    }
    if (table === sessionAgents) {
      if (cols.includes("session_id")) out = out.filter((row) => matches("sessionId", row));
      if (cols.includes("project_id")) out = out.filter((row) => matches("projectId", row));
    }
    if (table === projectSessions) {
      // `id` first: appendMessage/discardSession update by the uuid primary key.
      if (cols.includes("id")) out = out.filter((row) => matches("id", row));
      if (cols.includes("project_id")) out = out.filter((row) => matches("projectId", row));
      if (cols.includes("origin")) out = out.filter((row) => matches("origin", row));
      if (cols.includes("deleted_at")) out = out.filter(isLive);
    }
    return out;
  }

  function result(rows: Array<Row>) {
    const promise = Promise.resolve(rows);
    return {
      // Mirrors drizzle's orderBy: every argument is an order term (column +
      // direction); multiple terms break ties left to right.
      orderBy: (...args: Array<unknown>) => {
        const terms = orderTerms(args);
        const sorted = [...rows].sort((a, b) => {
          for (const term of terms) {
            const at = timeValue(a[rowKey(term.column)]);
            const bt = timeValue(b[rowKey(term.column)]);
            if (at !== bt) return (at - bt) * term.direction;
          }
          return 0;
        });
        return Promise.resolve(sorted);
      },
      limit: (limit: number) => Promise.resolve(rows.slice(0, limit)),
      returning: () => Promise.resolve(rows),
      then: (
        onFulfilled?: (value: Array<Row>) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => promise.then(onFulfilled, onRejected),
    };
  }

  function selectBuilder(table: unknown) {
    let recorded = false;
    const joins: Array<unknown> = [];
    const resolve = (cond: unknown): Array<Row> => {
      if (!recorded) {
        ops.push({ kind: "select", table, cond });
        recorded = true;
      }
      let rows = filterRows(table, rowsFor(table), cond);
      // The only join the repository issues: project_sessions ⟕ session_agents
      // on the uuid session id (0010). Attach the agent so the projection sees it.
      if (table === projectSessions && joins.includes(sessionAgents)) {
        rows = rows.map((row) => ({
          ...row,
          agentId:
            state.sessionAgents.find((agent) => agent.sessionId === row.id)
              ?.agentId ?? null,
        }));
      }
      // Chain 0009: session_messages ⋈ project_sessions on the uuid FK for
      // project-scoped reads. Keep only messages whose parent registry row is
      // live and (when the cond carries a project_id value) belongs to that
      // project.
      if (table === sessionMessages && joins.includes(projectSessions)) {
        const wanted = referencedValues(cond).filter(
          (value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value),
        );
        rows = rows.filter((row) => {
          const parent = state.projectSessions.find(
            (session) => session.id === row.sessionId && isLive(session),
          );
          if (!parent) return false;
          if (wanted.length === 0) return true;
          return wanted.includes(parent.projectId);
        });
      }
      // Drizzle projection: select({ id: domainId, ... }) — the fake stores
      // both the surrogate (`row-*`) and the domain id, so project the wire
      // id back (otherwise chain tests link on surrogate ids, never real).
      if (table === sessionMessages) {
        rows = rows.map((row) => ({ ...row, id: row.domainId ?? row.id }));
      }
      return rows.map((row) => ({ ...row }));
    };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.where = (cond: unknown) => result(resolve(cond));
    builder.leftJoin = (joinTable: unknown) => {
      joins.push(joinTable);
      return builder;
    };
    builder.innerJoin = (joinTable: unknown) => {
      joins.push(joinTable);
      return builder;
    };
    builder.orderBy = chain;
    return builder;
  }

  function updateBuilder(table: unknown) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          ops.push({ kind: "update", table, values, cond });
          for (const row of filterRows(table, rowsFor(table), cond)) {
            Object.assign(row, values);
          }
          return result([]);
        },
      }),
    };
  }

  function insertBuilder(table: unknown) {
    return {
      values: (values: Record<string, unknown>) => {
        const apply = (mode: "nothing" | "update"): void => {
          ops.push({ kind: "insert", table, values, conflict: mode });
          const rows = rowsFor(table);
          if (table === sessionMessages) {
            // 0010: replay dedupes on domain_id (surrogate uuid is per-row).
            if (!rows.some((row) => row.domainId === values.domainId)) {
              rows.push({ id: `row-${String(values.domainId)}`, ...values });
            }
            return;
          }
          if (table === sessionAgents) {
            const existing = rows.find((row) => row.sessionId === values.sessionId);
            if (existing) Object.assign(existing, values);
            else rows.push({ ...values });
            return;
          }
          if (table === projectSessions) {
            if (!rows.some((row) => row.id === values.id)) rows.push({ ...values });
          }
        };
        return {
          onConflictDoNothing: () => {
            apply("nothing");
            return Promise.resolve();
          },
          onConflictDoUpdate: () => {
            apply("update");
            return Promise.resolve();
          },
          returning: () => {
            apply("nothing");
            return Promise.resolve([{ ...values }]);
          },
        };
      },
    };
  }

  const client = {
    select: () => ({ from: (table: unknown) => selectBuilder(table) }),
    selectDistinct: () => ({ from: (table: unknown) => selectBuilder(table) }),
    insert: (table: unknown) => insertBuilder(table),
    update: (table: unknown) => updateBuilder(table),
  };

  return { client, ops, state };
}

function makeRepo(db: { client: unknown }): SessionHistoryRepository {
  return new SessionHistoryRepository(
    db as unknown as ConstructorParameters<typeof SessionHistoryRepository>[0],
    silentLogger(),
  );
}

function messageRow(overrides: Partial<Row> = {}): Row {
  // Seeds historically pass { id: "mX" } meaning the DOMAIN id; the 0010
  // surrogate uuid is never asserted, so both default from the domain value.
  const domainId: string =
    typeof overrides.domainId === "string"
      ? (overrides.domainId as string)
      : typeof overrides.id === "string"
        ? (overrides.id as string)
        : "m1";
  return {
    sessionId: HARNESS_ID,
    userId: UID,
    role: "user",
    agentId: null,
    text: "hi",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
    id: `row-${domainId}`,
    domainId,
  };
}

describe("SessionHistoryRepository.listMessages", () => {
  it("filters soft-deleted rows and maps role → type, oldest first", async () => {
    const db = makeDb({
      sessionMessages: [
        messageRow({ id: "m2", role: "assistant", text: "yo", createdAt: new Date("2026-01-01T00:00:01.000Z") }),
        messageRow({ id: "m1", role: "user", text: "hi" }),
        messageRow({ id: "m3", text: "gone", deletedAt: new Date("2026-01-02T00:00:00.000Z") }),
        messageRow({ id: "m4", sessionId: "0190a0b0-0000-7000-8000-000000000099", text: "foreign" }),
      ],
    });
    const repo = makeRepo(db);
    const out = await repo.listMessages(HARNESS_ID);
    assert.deepEqual(
      out.map((row) => row.id),
      ["m1", "m2"],
      "soft-deleted and foreign-session rows must be dropped",
    );
    assert.deepEqual(out.map((row) => row.type), ["user", "assistant"]);
    assert.equal(out[0].text, "hi");
    assert.equal(out[1].createdAt, new Date("2026-01-01T00:00:01.000Z").toISOString());
    const select = db.ops.find((op) => op.kind === "select");
    assert.ok(select, "the repository must issue a select");
    assert.ok(
      referencedColumns(select?.cond).includes("deleted_at"),
      "reads must constrain deleted_at",
    );
  });

  it("project scope joins project_sessions (no direct project_id on messages)", async () => {
    const db = makeDb({
      projectSessions: [
        { id: HARNESS_ID, projectId: PID, deletedAt: null },
      ],
      sessionMessages: [
        messageRow({ id: "m1", sessionId: HARNESS_ID }),
      ],
    });
    const repo = makeRepo(db);
    const out = await repo.listMessages(HARNESS_ID, PID);
    assert.deepEqual(out.map((row) => row.id), ["m1"]);
  });
});

describe("SessionHistoryRepository.appendMessage", () => {
  it("is idempotent on the message id (onConflictDoNothing)", async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const row = {
      id: "m1",
      sessionId: HARNESS_ID,
      userId: UID,
      role: "user" as const,
      text: "hi",
    };
    await repo.appendMessage(row);
    await repo.appendMessage(row);
    assert.equal(db.state.sessionMessages.length, 1, "a replayed id must not duplicate");
    const inserts = db.ops.filter((op) => op.kind === "insert");
    assert.equal(inserts.length, 2);
    assert.ok(inserts.every((op) => op.conflict === "nothing"));
  });

  it("bumps updatedAt only on the matching uuid row", async () => {
    const before = new Date("2026-01-01T00:00:00.000Z");
    const db = makeDb({
      projectSessions: [
        { id: HARNESS_ID, projectId: PID, updatedAt: before, deletedAt: null },
        {
          id: "0190a0b0-0000-7000-8000-000000000002",
          projectId: PID,
          updatedAt: before,
          deletedAt: null,
        },
      ],
    });
    const repo = makeRepo(db);
    await repo.appendMessage({
      id: "m1",
      sessionId: HARNESS_ID,
      userId: UID,
      role: "user" as const,
      text: "hi",
    });
    const updates = db.ops.filter((op) => op.kind === "update");
    assert.equal(updates.length, 1, "one bump update expected");
    assert.equal(db.state.projectSessions[0].updatedAt instanceof Date, true);
    assert.ok(
      (db.state.projectSessions[0].updatedAt as Date).getTime() >= before.getTime(),
      "matching row must be bumped",
    );
    assert.deepEqual(
      db.state.projectSessions[1].updatedAt,
      before,
      "non-matching uuid row must stay untouched",
    );
  });

  it("stores no project_id (chain: scope via project_sessions JOIN, RESTRICT)", async () => {
    const db = makeDb({
      projectSessions: [
        {
          id: HARNESS_ID,
          projectId: PID,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          deletedAt: null,
        },
      ],
    });
    const repo = makeRepo(db);
    await repo.appendMessage({
      id: "m1",
      sessionId: HARNESS_ID,
      userId: UID,
      role: "user" as const,
      text: "hi",
    });
    assert.equal(db.state.sessionMessages.length, 1, "the message row itself is still stored");
    assert.ok(
      !("projectId" in db.state.sessionMessages[0]),
      "message rows must not carry projectId (0009 dropped the column)",
    );
    assert.equal(
      db.ops.filter((op) => op.kind === "update").length,
      1,
      "uuid session always bumps its parent registry row (no ses_* no-op branch)",
    );
  });
});

describe("SessionHistoryRepository agents", () => {
  it("setAgent upserts and getAgent reads the stored id", async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    assert.equal(await repo.getAgent(HARNESS_ID), undefined);
    await repo.setAgent(HARNESS_ID, PID, "ask");
    assert.equal(await repo.getAgent(HARNESS_ID), "ask");
    await repo.setAgent(HARNESS_ID, PID, "auto");
    assert.equal(db.state.sessionAgents.length, 1, "sessionAgents must stay one row per session");
    assert.equal(await repo.getAgent(HARNESS_ID), "auto");
    assert.ok(
      db.ops.some((op) => op.kind === "insert" && op.conflict === "update"),
      "setAgent must honour onConflictDoUpdate",
    );
  });
});

describe("SessionHistoryRepository.listLocalSessions", () => {
  it("returns only origin='harness' rows with metadata + stored agent restored", async () => {
    const db = makeDb({
      projectSessions: [
        {
          id: HARNESS_ID,
          projectId: PID,
          chatId: null,
          status: "open",
          origin: "harness",
          metadata: {
            title: "Local",
            directory: "/tmp/jail",
            model: { id: "model-x", providerID: "provider-y" },
            status: { type: "idle" },
          },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          deletedAt: null,
        },
        {
          id: "0190a0b0-0000-7000-8000-000000000002",
          projectId: PID,
          origin: "upstream",
          metadata: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          deletedAt: null,
        },
      ],
      sessionAgents: [{ sessionId: HARNESS_ID, projectId: PID, agentId: "ask" }],
    });
    const repo = makeRepo(db);
    const out = await repo.listLocalSessions(PID);
    assert.equal(out.length, 1, "upstream rows must not leak into the local list");
    assert.equal(out[0].id, HARNESS_ID);
    assert.equal(out[0].title, "Local");
    assert.equal(out[0].directory, "/tmp/jail");
    assert.deepEqual(out[0].model, { id: "model-x", providerID: "provider-y" });
    assert.deepEqual(out[0].status, { type: "idle" });
    assert.equal(out[0].agentId, "ask");
    assert.equal(out[0].projectId, PID);
    assert.equal(out[0].createdAt, new Date("2026-01-01T00:00:00.000Z").toISOString());
    assert.equal(out[0].updatedAt, new Date("2026-01-01T00:00:00.000Z").toISOString());
  });

  it("orders by updatedAt desc even when createdAt says otherwise", async () => {
    const db = makeDb({
      projectSessions: [
        {
          id: "0190a0b0-0000-7000-8000-000000000010",
          projectId: PID,
          origin: "harness",
          metadata: { title: "Old", directory: "/tmp/jail", status: { type: "idle" } },
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          deletedAt: null,
        },
        {
          id: "0190a0b0-0000-7000-8000-000000000011",
          projectId: PID,
          origin: "harness",
          metadata: { title: "New", directory: "/tmp/jail", status: { type: "idle" } },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-05T00:00:00.000Z"),
          deletedAt: null,
        },
      ],
    });
    const repo = makeRepo(db);
    const out = await repo.listLocalSessions(PID);
    assert.deepEqual(
      out.map((row) => row.id),
      ["0190a0b0-0000-7000-8000-000000000011", "0190a0b0-0000-7000-8000-000000000010"],
      "updatedAt-newest must come first regardless of createdAt",
    );
    assert.equal(out[0].updatedAt, new Date("2026-01-05T00:00:00.000Z").toISOString());
  });

  it("tie on updatedAt breaks by createdAt desc", async () => {
    const db = makeDb({
      projectSessions: [
        {
          id: "0190a0b0-0000-7000-8000-000000000020",
          projectId: PID,
          origin: "harness",
          metadata: { title: "Older", directory: "/tmp/jail", status: { type: "idle" } },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-05T00:00:00.000Z"),
          deletedAt: null,
        },
        {
          id: "0190a0b0-0000-7000-8000-000000000021",
          projectId: PID,
          origin: "harness",
          metadata: { title: "Newer", directory: "/tmp/jail", status: { type: "idle" } },
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
          updatedAt: new Date("2026-01-05T00:00:00.000Z"),
          deletedAt: null,
        },
      ],
    });
    const repo = makeRepo(db);
    const out = await repo.listLocalSessions(PID);
    assert.deepEqual(
      out.map((row) => row.id),
      ["0190a0b0-0000-7000-8000-000000000021", "0190a0b0-0000-7000-8000-000000000020"],
      "equal updatedAt must fall back to createdAt desc",
    );
  });

  it("identical timestamps keep both rows (empty project returns [])", async () => {
    const same = new Date("2026-01-05T00:00:00.000Z");
    const db = makeDb({
      projectSessions: [
        {
          id: "0190a0b0-0000-7000-8000-000000000030",
          projectId: PID,
          origin: "harness",
          metadata: { title: "A", directory: "/tmp/jail", status: { type: "idle" } },
          createdAt: same,
          updatedAt: same,
          deletedAt: null,
        },
        {
          id: "0190a0b0-0000-7000-8000-000000000031",
          projectId: PID,
          origin: "harness",
          metadata: { title: "B", directory: "/tmp/jail", status: { type: "idle" } },
          createdAt: same,
          updatedAt: same,
          deletedAt: null,
        },
      ],
    });
    const repo = makeRepo(db);
    const out = await repo.listLocalSessions(PID);
    assert.equal(out.length, 2, "identical timestamps must not drop rows");
    assert.deepEqual(
      out.map((row) => row.id).sort(),
      ["0190a0b0-0000-7000-8000-000000000030", "0190a0b0-0000-7000-8000-000000000031"],
      "identical timestamps keep the full set (SQL has no id term — order is DB-defined)",
    );
    const empty = makeDb();
    assert.deepEqual(await makeRepo(empty).listLocalSessions(PID), [], "empty project must be []");
  });
});

describe("SessionHistoryRepository branches", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const t1 = new Date("2026-01-01T00:00:01.000Z");
  const t2 = new Date("2026-01-01T00:00:02.000Z");
  const t3 = new Date("2026-01-01T00:00:03.000Z");

  it("orderByParentChain keeps every row on 1 parent → N children (no fallback)", async () => {
    const rows = [
      { id: "root", parentId: null, createdAt: t0 },
      { id: "b", parentId: "root", createdAt: t1 },
      { id: "c", parentId: "root", createdAt: t2 },
      { id: "d", parentId: "b", createdAt: t3 },
    ];
    const out = orderByParentChain(rows);
    assert.deepEqual(
      out.map((row) => row.id).sort(),
      ["b", "c", "d", "root"],
      "branches must not drop rows",
    );
    assert.equal(out[0]?.id, "root", "the root stays first");
  });

  it("listActiveChain walks leaf → root (siblings out)", async () => {
    const db = makeDb({
      sessionMessages: [
        messageRow({ id: "root", parentId: null, createdAt: t0 }),
        messageRow({ id: "b", parentId: "root", createdAt: t1 }),
        messageRow({ id: "c", parentId: "root", createdAt: t2 }),
      ],
    });
    const repo = makeRepo(db);
    const chain = await repo.listActiveChain(HARNESS_ID, "c");
    assert.deepEqual(chain.map((row) => row.id), ["root", "c"]);
  });

  it("listVariants lists children time-ordered with previews", async () => {
    const db = makeDb({
      sessionMessages: [
        messageRow({ id: "root", parentId: null, createdAt: t0, text: "root text" }),
        messageRow({ id: "b", parentId: "root", createdAt: t2, text: "second answer here" }),
        messageRow({ id: "c", parentId: "root", createdAt: t1, text: "first answer here" }),
      ],
    });
    const repo = makeRepo(db);
    const variants = await repo.listVariants(HARNESS_ID, "root");
    assert.deepEqual(variants.map((row) => row.childId), ["c", "b"]);
    assert.ok(variants.every((row) => row.preview.length > 0));
  });

  it("revertMessages soft-deletes the boundary + descendants and answers the parent", async () => {
    const db = makeDb({
      sessionMessages: [
        messageRow({ id: "root", parentId: null, createdAt: t0 }),
        messageRow({ id: "b", parentId: "root", createdAt: t1 }),
        messageRow({ id: "d", parentId: "b", createdAt: t2 }),
        messageRow({ id: "c", parentId: "root", createdAt: t3 }),
      ],
    });
    const repo = makeRepo(db);
    const activeLeaf = await repo.revertMessages(HARNESS_ID, "b");
    assert.equal(activeLeaf, "root");
    const remaining = await repo.listMessages(HARNESS_ID);
    assert.deepEqual(remaining.map((row) => row.id).sort(), ["c", "root"]);
  });

  it("revertMessages on an unknown boundary answers undefined (service maps 404)", async () => {
    const db = makeDb({ sessionMessages: [messageRow({ id: "root" })] });
    const repo = makeRepo(db);
    assert.equal(await repo.revertMessages(HARNESS_ID, "nope"), undefined);
  });

  it("revertMessages on the root answers null (empty thread)", async () => {
    const db = makeDb({
      sessionMessages: [
        messageRow({ id: "root", parentId: null, createdAt: t0 }),
        messageRow({ id: "b", parentId: "root", createdAt: t1 }),
      ],
    });
    const repo = makeRepo(db);
    assert.equal(await repo.revertMessages(HARNESS_ID, "root"), null);
    assert.deepEqual(await repo.listMessages(HARNESS_ID), []);
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
    `session history repository checks failed to run: ${(err as Error).message}`,
  );
  process.exit(1);
});
