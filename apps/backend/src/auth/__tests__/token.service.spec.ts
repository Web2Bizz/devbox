import assert from "node:assert/strict";
import { getTableName } from "drizzle-orm";
import { TokenService } from "../token.service";

type Row = Record<string, unknown>;

type Op = {
  kind: "select" | "insert" | "update" | "delete";
  table: string;
  values?: Row;
  cond?: unknown;
};

type FakeDb = {
  client: Record<string, unknown>;
  ops: Array<Op>;
  rows: (table?: string) => Array<Row>;
  transactions: () => number;
  deletes: () => number;
  resetOps: () => void;
};

type Tok =
  | { t: "col"; name: string; table: unknown }
  | { t: "param"; value: unknown }
  | { t: "kw"; v: string };

type Case = { name: string; run: () => Promise<void> | void };

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

const USER_ID = "123e4567-e89b-12d3-a456-426614174001";
const EMAIL = "refresh-store@example.com";
const ACCESS_SECRET = "unit-test-access-secret";
const REFRESH_SECRET = "unit-test-refresh-secret";
const ACCESS_TTL_SEC = 900;
const REFRESH_TTL_SEC = 604800;

function tableName(table: unknown): string {
  return getTableName(table as never);
}

const COLUMNS = Symbol.for("drizzle:Columns");

function resolveProp(table: unknown, dbName: string, row: Row): string {
  let cols: unknown;
  try {
    cols = (table as Record<symbol, unknown>)[COLUMNS];
  } catch {
    cols = undefined;
  }
  if (cols !== null && cols !== undefined && typeof cols === "object") {
    for (const [prop, col] of Object.entries(cols as Record<string, unknown>)) {
      const name = (col as { name?: unknown } | null)?.name;
      if (typeof name === "string" && name === dbName) return prop;
    }
  }
  if (dbName in row) return dbName;
  return dbName.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function tokenize(node: unknown): Array<Tok> {
  const out: Array<Tok> = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.queryChunks)) {
      for (const chunk of obj.queryChunks) visit(chunk);
      return;
    }
    if (typeof obj.name === "string" && "table" in obj) {
      out.push({ t: "col", name: obj.name, table: obj.table });
      return;
    }
    if ("encoder" in obj) {
      out.push({ t: "param", value: obj.value });
      return;
    }
    if (Array.isArray(obj.value)) {
      const text = (obj.value as Array<unknown>).map((item) => String(item)).join("");
      for (const part of text.split(/(\(|\))/)) {
        if (part === "") continue;
        if (part === "(" || part === ")") {
          out.push({ t: "kw", v: part });
          continue;
        }
        for (const word of part.trim().split(/\s+/)) {
          if (word !== "") out.push({ t: "kw", v: word.toLowerCase() });
        }
      }
    }
  };
  visit(node);
  return out;
}

function readColumn(tok: { name: string; table: unknown }, row: Row): unknown {
  return row[resolveProp(tok.table, tok.name, row)];
}

function comparable(value: unknown): string | number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value).getTime();
  }
  if (typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

function compare(left: unknown, right: unknown): number {
  const a = comparable(left);
  const b = comparable(right);
  if (typeof a === "number" && typeof b === "number") {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function evalCondition(cond: unknown, row: Row): boolean {
  if (cond === undefined || cond === null) return true;
  const toks = tokenize(cond);
  let index = 0;

  const peek = (): Tok | undefined => toks[index];
  const eat = (): Tok | undefined => {
    const tok = toks[index];
    index += 1;
    return tok;
  };

  const parseOr = (): boolean => {
    let value = parseAnd();
    while (peek()?.t === "kw" && (peek() as { v: string }).v === "or") {
      eat();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };

  const parseAnd = (): boolean => {
    let value = parseAtom();
    while (peek()?.t === "kw" && (peek() as { v: string }).v === "and") {
      eat();
      const right = parseAtom();
      value = value && right;
    }
    return value;
  };

  const parseAtom = (): boolean => {
    const first = peek();
    if (first?.t === "kw" && first.v === "(") {
      eat();
      const inner = parseOr();
      const close = peek();
      if (close?.t === "kw" && close.v === ")") eat();
      return inner;
    }
    const left = eat();
    if (left?.t === "kw" && (left.v === "true" || left.v === "false")) {
      return left.v === "true";
    }
    if (left?.t !== "col") {
      throw new Error(`unsupported refresh-store condition: ${JSON.stringify(left)}`);
    }
    const op = eat();
    if (op?.t !== "kw") {
      throw new Error(`unsupported refresh-store operator: ${JSON.stringify(op)}`);
    }
    if (op.v === "is") {
      const maybeNot = peek();
      const negated = maybeNot?.t === "kw" && maybeNot.v === "not";
      if (negated) eat();
      const nul = eat();
      if (nul?.t !== "kw" || nul.v !== "null") {
        throw new Error("only IS [NOT] NULL is supported");
      }
      const actual = readColumn(left, row);
      return negated
        ? actual !== null && actual !== undefined
        : actual === null || actual === undefined;
    }
    if (op.v === "in") {
      const actual = readColumn(left, row);
      const candidates: Array<unknown> = [];
      while (true) {
        const next = peek();
        if (next?.t === "param") {
          eat();
          candidates.push(next.value);
          continue;
        }
        if (next?.t === "kw" && next.v === "(") {
          eat();
          continue;
        }
        if (next?.t === "kw" && next.v === ")") {
          eat();
          break;
        }
        break;
      }
      return candidates.some((candidate) => compare(actual, candidate) === 0);
    }
    const right = eat();
    let expected = right?.t === "param" ? right.value : undefined;
    if (right?.t === "kw" && right.v === "now") {
      const open = eat();
      const close = eat();
      if (open?.t === "kw" && open.v === "(" && close?.t === "kw" && close.v === ")") {
        expected = new Date();
      }
    }
    const actual = readColumn(left, row);
    if (op.v === "=") {
      const actualNull = actual === null || actual === undefined;
      const expectedNull = expected === null || expected === undefined;
      if (actualNull || expectedNull) return actualNull && expectedNull;
      return compare(actual, expected) === 0;
    }
    const cmp = compare(actual, expected);
    if (op.v === "<>") return cmp !== 0;
    if (op.v === "<") return cmp < 0;
    if (op.v === "<=") return cmp <= 0;
    if (op.v === ">") return cmp > 0;
    if (op.v === ">=") return cmp >= 0;
    throw new Error(`unsupported refresh-store operator: ${op.v}`);
  };

  return parseOr();
}

function rowsResult(list: Array<Row>) {
  return {
    returning: () => Promise.resolve(list),
    then: (
      onFulfilled?: (value: Array<Row>) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(list).then(onFulfilled, onRejected),
  };
}

function makeDb(): FakeDb {
  const state = new Map<string, Array<Row>>();
  const ops: Array<Op> = [];
  let transactions = 0;

  const rows = (table = "refresh_tokens"): Array<Row> => {
    let list = state.get(table);
    if (!list) {
      list = [];
      state.set(table, list);
    }
    return list;
  };

  const normalize = (value: unknown): unknown => {
    if (
      value !== null &&
      typeof value === "object" &&
      Array.isArray((value as { queryChunks?: unknown }).queryChunks)
    ) {
      const text = ((value as { queryChunks: Array<unknown> }).queryChunks)
        .map((chunk) => {
          if (
            chunk !== null &&
            typeof chunk === "object" &&
            Array.isArray((chunk as { value?: unknown }).value)
          ) {
            return ((chunk as { value: Array<unknown> }).value).join("");
          }
          return "";
        })
        .join(" ")
        .toLowerCase();
      if (text.includes("now()")) return new Date();
    }
    return value;
  };

  const normalizeValues = (values: Row): Row => {
    const out: Row = {};
    for (const [key, value] of Object.entries(values)) out[key] = normalize(value);
    return out;
  };

  const insertBuilder = (table: unknown) => {
    const name = tableName(table);
    return {
      values: (values: Row | Array<Row>) => {
        const list = (Array.isArray(values) ? values : [values]).map((value) => {
          const row = normalizeValues(value);
          if (!("revokedAt" in row)) row.revokedAt = null;
          if (!("deletedAt" in row)) row.deletedAt = null;
          return row;
        });
        rows(name).push(...list);
        ops.push({ kind: "insert", table: name, values: list[0] });
        const result = list.map((row) => ({ ...row }));
        const builder: Record<string, unknown> = {
          returning: () => Promise.resolve(result),
          onConflictDoNothing: () => builder,
          onConflictDoUpdate: () => builder,
          then: (
            onFulfilled?: (value: Array<Row>) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(result).then(onFulfilled, onRejected),
        };
        return builder;
      },
    };
  };

  const updateBuilder = (table: unknown) => {
    const name = tableName(table);
    return {
      set: (values: Row) => {
        const patch = normalizeValues(values);
        const apply = (cond: unknown): Array<Row> => {
          ops.push({ kind: "update", table: name, values: patch, cond });
          const matched = rows(name).filter((row) => evalCondition(cond, row));
          for (const row of matched) Object.assign(row, patch);
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
  };

  const deleteBuilder = (table: unknown) => {
    const name = tableName(table);
    const apply = (cond: unknown): Array<Row> => {
      ops.push({ kind: "delete", table: name, cond });
      const current = rows(name);
      const matched = current.filter((row) => evalCondition(cond, row));
      for (const row of matched) {
        const at = current.indexOf(row);
        if (at >= 0) current.splice(at, 1);
      }
      return matched.map((row) => ({ ...row }));
    };
    return {
      where: (cond: unknown) => rowsResult(apply(cond)),
      then: (
        onFulfilled?: (value: Array<Row>) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(apply(undefined)).then(onFulfilled, onRejected),
    };
  };

  const selectBuilder = (table: unknown) => {
    const name = tableName(table);
    let cond: unknown;
    let limit: number | undefined;
    const resolve = (): Array<Row> => {
      ops.push({ kind: "select", table: name, cond });
      let list = rows(name).filter((row) => evalCondition(cond, row));
      if (limit !== undefined) list = list.slice(0, limit);
      return list.map((row) => ({ ...row }));
    };
    const builder: Record<string, unknown> = {
      where: (value: unknown) => {
        cond = value;
        return builder;
      },
      limit: (value: number) => {
        limit = value;
        return builder;
      },
      orderBy: () => builder,
      for: () => builder,
      then: (
        onFulfilled?: (value: Array<Row>) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return builder;
  };

  const client: Record<string, unknown> = {
    select: () => ({ from: (table: unknown) => selectBuilder(table) }),
    insert: (table: unknown) => insertBuilder(table),
    update: (table: unknown) => updateBuilder(table),
    delete: (table: unknown) => deleteBuilder(table),
  };
  client.transaction = async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    transactions += 1;
    return cb(client);
  };

  return {
    client,
    ops,
    rows,
    transactions: () => transactions,
    deletes: () => ops.filter((op) => op.kind === "delete").length,
    resetOps: () => {
      ops.length = 0;
    },
  };
}

function makeService(db: FakeDb): TokenService {
  const Ctor = TokenService as unknown as new (first: unknown, second: unknown) => TokenService;
  const dbAndLogger = {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
    withCorrelationId() {
      return dbAndLogger;
    },
    get client() {
      return db.client;
    },
  };
  return new Ctor(dbAndLogger, dbAndLogger);
}

async function issue(svc: TokenService, userId = USER_ID) {
  return svc.issuePair(
    { id: userId, email: EMAIL },
    ACCESS_SECRET,
    REFRESH_SECRET,
    ACCESS_TTL_SEC,
    REFRESH_TTL_SEC,
  );
}

async function consume(svc: TokenService, token: string) {
  return svc.consumeRefresh(
    token,
    REFRESH_SECRET,
    () => EMAIL,
    ACCESS_SECRET,
    ACCESS_TTL_SEC,
    REFRESH_TTL_SEC,
  );
}

async function prune(svc: TokenService): Promise<void> {
  const target = svc as unknown as {
    pruneExpired?: () => Promise<void> | void;
    prune?: () => Promise<void> | void;
  };
  const fn = target.pruneExpired ?? target.prune;
  assert.equal(typeof fn, "function", "TokenService must expose pruneExpired() or prune()");
  await fn?.call(svc);
}

function jtiOf(token: string): string {
  const parts = token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
    jti?: unknown;
  };
  return typeof payload.jti === "string" ? payload.jti : "";
}

function rowById(db: FakeDb, id: string): Row | undefined {
  return db.rows().find((row) => row.id === id);
}

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function asTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value).getTime();
  }
  return Number.NaN;
}

function conditionColumns(condition: unknown): Array<string> {
  const columns: Array<string> = [];
  for (const token of tokenize(condition)) {
    if (token.t === "col") columns.push(token.name);
  }
  return columns;
}

function hasIsNull(condition: unknown, column: string): boolean {
  const tokens = tokenize(condition);
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const columnToken = tokens[index];
    const isToken = tokens[index + 1];
    const nullToken = tokens[index + 2];
    if (!columnToken || columnToken.t !== "col" || columnToken.name !== column) continue;
    if (!isToken || isToken.t !== "kw" || isToken.v !== "is") continue;
    if (!nullToken || nullToken.t !== "kw" || nullToken.v !== "null") continue;
    return true;
  }
  return false;
}

function hasComparison(condition: unknown, column: string, operator: string): boolean {
  const tokens = tokenize(condition);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const columnToken = tokens[index];
    const operatorToken = tokens[index + 1];
    if (!columnToken || columnToken.t !== "col" || columnToken.name !== column) continue;
    if (operatorToken && operatorToken.t === "kw" && operatorToken.v === operator) return true;
  }
  return false;
}

describe("TokenService persistent refresh store", () => {
  it("issuePair inserts the refresh jti into refresh_tokens", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const pair = await issue(svc);

    assert.equal(
      db.ops.filter((op) => op.kind === "insert" && op.table === "refresh_tokens").length,
      1,
    );
    assert.equal(db.rows().length, 1);
    const row = db.rows()[0];
    assert.ok(row);
    assert.equal(row.id, jtiOf(pair.refreshToken));
    assert.equal(row.userId, USER_ID);
    assert.equal(row.revokedAt, null);
    assert.equal(row.deletedAt, null);
    assert.ok(Math.abs(asTime(row.issuedAt) - Date.now()) < 10000);
    assert.ok(asTime(row.expiresAt) - asTime(row.issuedAt) >= REFRESH_TTL_SEC * 1000 - 2000);
  });

  it("consumeRefresh rotates the token and marks the old jti revoked", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const first = await issue(svc);
    const rotated = await consume(svc, first.refreshToken);

    assert.ok(rotated);
    const oldRow = rowById(db, jtiOf(first.refreshToken));
    assert.ok(oldRow);
    assert.ok(isSet(oldRow.revokedAt), "the consumed jti must get revokedAt");
    assert.equal(oldRow.deletedAt, null);
    const newRow = rowById(db, jtiOf(rotated.refreshToken));
    assert.ok(newRow);
    assert.equal(newRow.revokedAt, null);
    assert.equal(db.deletes(), 0);
  });

  it("reusing a consumed jti is rejected and revokes the whole user chain", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const first = await issue(svc);
    const second = await issue(svc);
    const rotated = await consume(svc, first.refreshToken);
    assert.ok(rotated);

    const reused = await consume(svc, first.refreshToken);
    assert.equal(reused, null);

    const secondRow = rowById(db, jtiOf(second.refreshToken));
    assert.ok(secondRow);
    assert.ok(isSet(secondRow.revokedAt), "sibling jti must be revoked on reuse");
    const rotatedRow = rowById(db, jtiOf(rotated.refreshToken));
    assert.ok(rotatedRow);
    assert.ok(isSet(rotatedRow.revokedAt), "rotated jti must be revoked on reuse");

    assert.equal(await consume(svc, second.refreshToken), null);
    assert.equal(db.deletes(), 0);
  });

  it("a fresh TokenService instance accepts a token issued before a restart", async () => {
    const db = makeDb();
    const beforeRestart = makeService(db);
    const pair = await issue(beforeRestart);

    const afterRestart = makeService(db);
    const rotated = await consume(afterRestart, pair.refreshToken);

    assert.ok(rotated);
    const oldRow = rowById(db, jtiOf(pair.refreshToken));
    assert.ok(oldRow);
    assert.ok(isSet(oldRow.revokedAt));
    assert.ok(rowById(db, jtiOf(rotated.refreshToken)));
  });

  it("rejects an expired refresh_tokens row even when the JWT is still valid", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const pair = await issue(svc);
    const row = rowById(db, jtiOf(pair.refreshToken));
    assert.ok(row);
    row.expiresAt = new Date(Date.now() - 1000);

    const before = db.rows().length;
    assert.equal(await consume(svc, pair.refreshToken), null);
    assert.equal(db.rows().length, before);
    assert.equal(db.deletes(), 0);
  });

  it("pruneExpired marks deletedAt on expired rows only", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const live = await issue(svc);
    const expired = await issue(svc);
    const expiredRow = rowById(db, jtiOf(expired.refreshToken));
    assert.ok(expiredRow);
    expiredRow.expiresAt = new Date(Date.now() - 1000);

    await prune(svc);

    const liveRow = rowById(db, jtiOf(live.refreshToken));
    assert.ok(liveRow);
    assert.ok(isSet(expiredRow.deletedAt), "prune must soft-delete the expired row");
    assert.equal(liveRow.deletedAt, null, "prune must not touch a live row");
    assert.equal(db.deletes(), 0);
  });

  it("revokeRefresh marks revokedAt instead of deleting the row", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const pair = await issue(svc);

    await svc.revokeRefresh(pair.refreshToken, REFRESH_SECRET);

    const row = rowById(db, jtiOf(pair.refreshToken));
    assert.ok(row);
    assert.ok(isSet(row.revokedAt));
    assert.equal(row.deletedAt, null);
    assert.equal(await consume(svc, pair.refreshToken), null);
    assert.equal(db.deletes(), 0);
  });

  it("revokeAll marks every active token of the user revoked without deleting", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const first = await issue(svc);
    const second = await issue(svc);
    const target = svc as unknown as {
      revokeAll?: (userId: string) => Promise<void> | void;
    };
    const revokeAll = target.revokeAll;
    assert.equal(typeof revokeAll, "function", "TokenService must expose revokeAll(userId)");
    await revokeAll?.call(svc, USER_ID);

    const firstRow = rowById(db, jtiOf(first.refreshToken));
    assert.ok(firstRow);
    assert.ok(isSet(firstRow.revokedAt));
    const secondRow = rowById(db, jtiOf(second.refreshToken));
    assert.ok(secondRow);
    assert.ok(isSet(secondRow.revokedAt));
    assert.equal(await consume(svc, first.refreshToken), null);
    assert.equal(db.deletes(), 0);
  });

  it("rejects a forged refresh token without writing or deleting rows", async () => {
    const db = makeDb();
    const svc = makeService(db);

    assert.equal(await consume(svc, "not-a-jwt"), null);
    assert.equal(db.rows().length, 0);
    assert.equal(db.ops.filter((op) => op.kind === "insert").length, 0);
    assert.equal(db.deletes(), 0);
  });

  it("never issues a physical DELETE across issue, rotate, reuse, revoke and prune", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const first = await issue(svc);
    const second = await issue(svc);
    const rotated = await consume(svc, first.refreshToken);
    assert.ok(rotated);
    assert.equal(await consume(svc, first.refreshToken), null);
    await svc.revokeRefresh(second.refreshToken, REFRESH_SECRET);
    const third = await issue(svc);
    const thirdRow = rowById(db, jtiOf(third.refreshToken));
    assert.ok(thirdRow);
    thirdRow.expiresAt = new Date(Date.now() - 1000);
    await prune(svc);

    assert.equal(db.deletes(), 0);
    assert.equal(db.ops.filter((op) => op.kind === "delete").length, 0);
  });

  it("claims the rotated jti with one conditional update and inserts in the same transaction", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const pair = await issue(svc);
    db.resetOps();

    const rotated = await consume(svc, pair.refreshToken);
    assert.ok(rotated);

    const claim = db.ops.find(
      (op) =>
        op.kind === "update" &&
        op.table === "refresh_tokens" &&
        conditionColumns(op.cond).includes("id"),
    );
    assert.ok(claim, "rotation must claim the jti with a single update");
    assert.ok(isSet(claim.values?.revokedAt), "the claim must mark the old jti revoked");
    for (const column of ["id", "user_id", "revoked_at", "deleted_at", "expires_at"]) {
      assert.ok(
        conditionColumns(claim.cond).includes(column),
        `the claim must filter on ${column}`,
      );
    }
    assert.ok(hasIsNull(claim.cond, "revoked_at"), "claim must require revoked_at IS NULL");
    assert.ok(hasIsNull(claim.cond, "deleted_at"), "claim must require deleted_at IS NULL");
    assert.ok(
      hasComparison(claim.cond, "expires_at", ">"),
      "claim must require expires_at > now()",
    );
    assert.equal(
      db.ops.filter((op) => op.kind === "select" && op.table === "refresh_tokens").length,
      0,
      "the happy path must not read before claiming",
    );
    assert.equal(db.transactions(), 1, "claim and insert must share one transaction");
    assert.ok(rowById(db, jtiOf(rotated.refreshToken)));
  });

  it("rotates a jti only once under concurrent consumeRefresh calls", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const pair = await issue(svc);
    db.resetOps();

    const results = await Promise.all([
      consume(svc, pair.refreshToken),
      consume(svc, pair.refreshToken),
    ]);

    const winners = results.filter((result) => result !== null);
    assert.equal(winners.length, 1, "exactly one concurrent rotation must win");
    assert.equal(db.ops.filter((op) => op.kind === "insert").length, 1, "only the winner inserts");

    const familyRevokes = db.ops.filter(
      (op) =>
        op.kind === "update" &&
        op.table === "refresh_tokens" &&
        conditionColumns(op.cond).includes("user_id") &&
        !conditionColumns(op.cond).includes("id"),
    );
    assert.equal(
      familyRevokes.length,
      1,
      "the losing call must revoke every live token of the user",
    );

    const winner = winners[0];
    assert.ok(winner);
    const winnerRow = rowById(db, jtiOf(winner.refreshToken));
    assert.ok(winnerRow, "the winner must persist its new jti");
    assert.ok(isSet(winnerRow.revokedAt), "the loser's reuse response revokes the winner chain");
    assert.equal(db.deletes(), 0);
  });

  it("rejects a valid JWT whose jti row is absent without writing", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const orphan = svc.sign({ sub: USER_ID, typ: "refresh" }, REFRESH_SECRET, REFRESH_TTL_SEC);

    assert.equal(await consume(svc, orphan.token), null);
    assert.equal(db.rows().length, 0);
    assert.equal(db.ops.filter((op) => op.kind === "insert").length, 0);
    assert.equal(db.deletes(), 0);
  });

  it("rejects a soft-pruned row and leaves it untouched", async () => {
    const db = makeDb();
    const svc = makeService(db);
    const pair = await issue(svc);
    const row = rowById(db, jtiOf(pair.refreshToken));
    assert.ok(row);
    row.deletedAt = new Date();
    db.resetOps();

    assert.equal(await consume(svc, pair.refreshToken), null);
    assert.equal(row.revokedAt, null, "a soft-pruned row must not be claimed");
    assert.equal(db.ops.filter((op) => op.kind === "insert").length, 0);
    assert.equal(db.deletes(), 0);
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
  console.log(`\n${cases.length - failed}/${cases.length} refresh-store checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`refresh-store checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
