import assert from "node:assert/strict";
import {
  projectSessions,
  sessionAgents,
  sessionMessages,
} from "../../../../../../common/db/schema";
import type { AppLogger } from "../../../../../../common/logger";
import { SessionHistoryRepository } from "../session-history.repository";

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
      if (cols.includes("session_id")) out = out.filter((row) => matches("sessionId", row));
      if (cols.includes("project_id")) out = out.filter((row) => matches("projectId", row));
      if (cols.includes("deleted_at")) out = out.filter(isLive);
    }
    if (table === sessionAgents) {
      if (cols.includes("session_id")) out = out.filter((row) => matches("sessionId", row));
      if (cols.includes("project_id")) out = out.filter((row) => matches("projectId", row));
    }
    if (table === projectSessions) {
      if (cols.includes("project_id")) out = out.filter((row) => matches("projectId", row));
      if (cols.includes("origin")) out = out.filter((row) => matches("origin", row));
      if (cols.includes("deleted_at")) out = out.filter(isLive);
    }
    return out;
  }

  function result(rows: Array<Row>) {
    const promise = Promise.resolve(rows);
    return {
      orderBy: () =>
        Promise.resolve(
          [...rows].sort((a, b) => {
            const at = (a.createdAt as Date | undefined)?.getTime() ?? 0;
            const bt = (b.createdAt as Date | undefined)?.getTime() ?? 0;
            return at - bt;
          }),
        ),
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
      // on the text session id. Attach the agent so the projection sees it.
      if (table === projectSessions && joins.includes(sessionAgents)) {
        rows = rows.map((row) => ({
          ...row,
          agentId:
            state.sessionAgents.find((agent) => agent.sessionId === row.id)
              ?.agentId ?? null,
        }));
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
            if (!rows.some((row) => row.id === values.id)) rows.push({ ...values });
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
  return {
    id: "m1",
    sessionId: "ses_a",
    projectId: PID,
    userId: UID,
    role: "user",
    agentId: null,
    text: "hi",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

describe("SessionHistoryRepository.listMessages", () => {
  it("filters soft-deleted rows and maps role → type, oldest first", async () => {
    const db = makeDb({
      sessionMessages: [
        messageRow({ id: "m2", role: "assistant", text: "yo", createdAt: new Date("2026-01-01T00:00:01.000Z") }),
        messageRow({ id: "m1", role: "user", text: "hi" }),
        messageRow({ id: "m3", text: "gone", deletedAt: new Date("2026-01-02T00:00:00.000Z") }),
        messageRow({ id: "m4", sessionId: "ses_other", text: "foreign" }),
      ],
    });
    const repo = makeRepo(db);
    const out = await repo.listMessages("ses_a");
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
});

describe("SessionHistoryRepository.appendMessage", () => {
  it("is idempotent on the message id (onConflictDoNothing)", async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const row = {
      id: "m1",
      sessionId: "ses_a",
      projectId: PID,
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
});

describe("SessionHistoryRepository agents", () => {
  it("setAgent upserts and getAgent reads the stored id", async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    assert.equal(await repo.getAgent("ses_a"), undefined);
    await repo.setAgent("ses_a", PID, "ask");
    assert.equal(await repo.getAgent("ses_a"), "ask");
    await repo.setAgent("ses_a", PID, "auto");
    assert.equal(db.state.sessionAgents.length, 1, "sessionAgents must stay one row per session");
    assert.equal(await repo.getAgent("ses_a"), "auto");
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
