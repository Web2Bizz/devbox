import assert from "node:assert/strict";
import { SessionHistoryRepository, orderByParentChain } from "../session-history.repository";
import type { AppLogger } from "@common/logger";

/**
 * parentId chain hardening (Фаза 1): ловит разрывы цепочки.
 * - orderByParentChain 1→N без fallback (ветки сохраняются, root первый)
 * - chain vs createdAt конфликт (ссылки побеждают часы)
 * - listActiveChain leafId leaf→root, siblings out, unknown → []
 * - listVariants time-ordered + preview scoped parentId (чужой parent → [])
 * - revertMessages boundary+descendants (doomed=[b,d] в inArray, c/root живы), root → null, unknown → undefined
 * - soft-deleted out contract-only (fetchRows уже отфильтровал — контракт: их нет в выдаче)
 * - hostile: empty, null/undefined parentId, dangling, cycle, multi-root
 */
type Case = { name: string; run: () => Promise<void> | void };
const cases: Array<Case> = [];
let suite = "";
function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}
function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

function silentLogger(): AppLogger {
  return { debug() {}, info() {}, log() {}, warn() {}, error() {}, fatal() {} } as unknown as AppLogger;
}

type Raw = { id: string; role: string; createdAt: Date; text: string; parentId: string | null | undefined };

function raw(id: string, parentId: string | null | undefined, at: string, text = id): Raw {
  return { id, role: "user", createdAt: new Date(at), text, parentId };
}

function referencedValues(cond: unknown): Array<unknown> {
  const out: Array<unknown> = [];
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
    if ("value" in obj && !Array.isArray(obj.value)) out.push(obj.value);
    if ("value" in obj && Array.isArray(obj.value)) {
      for (const item of obj.value as Array<unknown>) out.push(item);
    }
    for (const key of Object.keys(obj)) visit(obj[key]);
  };
  visit(cond);
  return out;
}

function repoWith(rows: Array<Raw>): SessionHistoryRepository {
  const fakeClient = {
    update: () => ({
      set: () => ({
        where: () => {
          return Promise.resolve([]);
        },
      }),
    }),
  };
  const repo = new SessionHistoryRepository({ client: fakeClient } as never, silentLogger());
  // fetchRows — приватный: подменяем выдачу живых строк (DB уже отсекла deletedAt).
  (repo as unknown as Record<string, unknown>).fetchRows = async () => rows.map((r) => ({ ...r }));
  return repo;
}

describe("orderByParentChain", () => {
  it("1 parent → N children: без fallback, root первый, дети по (at,id)", () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-01-01T00:00:01.000Z");
    const t2 = new Date("2026-01-01T00:00:02.000Z");
    const t3 = new Date("2026-01-01T00:00:03.000Z");
    const out = orderByParentChain([
      { id: "root", parentId: null, createdAt: t0 },
      { id: "b", parentId: "root", createdAt: t2 },
      { id: "c", parentId: "root", createdAt: t1 },
      { id: "d", parentId: "b", createdAt: t3 },
    ]);
    assert.deepEqual(out.map((r) => r.id), ["root", "c", "b", "d"]);
  });

  it("chain побеждает createdAt (tail по часам ≠ tip по ссылкам)", () => {
    // createdAt порядок: b,c,root — а цепочка root→b→c обязана выиграть.
    const out = orderByParentChain([
      { id: "root", parentId: null, createdAt: new Date("2026-01-01T00:00:02.000Z") },
      { id: "b", parentId: "root", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: "c", parentId: "b", createdAt: new Date("2026-01-01T00:00:01.000Z") },
    ]);
    assert.deepEqual(out.map((r) => r.id), ["root", "b", "c"]);
  });

  it("hostile: пусто и один элемент не падают", () => {
    assert.deepEqual(orderByParentChain([]), []);
    const one = [{ id: "x", parentId: null, createdAt: new Date() }];
    assert.deepEqual(orderByParentChain(one).map((r) => r.id), ["x"]);
  });

  it("hostile: dangling parent → fallback по (at,id), ничего не теряется", () => {
    const rows = [
      { id: "a", parentId: null, createdAt: new Date("2026-01-01T00:00:01.000Z") },
      { id: "b", parentId: "ghost", createdAt: new Date("2026-01-01T00:00:00.000Z") },
    ];
    const out = orderByParentChain(rows);
    assert.deepEqual(out.map((r) => r.id), ["b", "a"]);
  });

  it("hostile: ноль корней и мульти-корни → fallback, все ряды живы", () => {
    const multi = [
      { id: "r1", parentId: null, createdAt: new Date("2026-01-01T00:00:01.000Z") },
      { id: "r2", parentId: null, createdAt: new Date("2026-01-01T00:00:00.000Z") },
    ];
    assert.deepEqual(orderByParentChain(multi).map((r) => r.id), ["r2", "r1"]);
    const zero = [
      { id: "a", parentId: "b", createdAt: new Date("2026-01-01T00:00:01.000Z") },
      { id: "b", parentId: "a", createdAt: new Date("2026-01-01T00:00:00.000Z") },
    ];
    assert.equal(orderByParentChain(zero).length, 2, "цикл обязан откатиться, не потерять ряды");
  });

  it("null и undefined parentId оба считаются корнями", () => {
    const out = orderByParentChain([
      { id: "a", parentId: undefined, createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: "b", parentId: "a", createdAt: new Date("2026-01-01T00:00:01.000Z") },
    ]);
    assert.deepEqual(out.map((r) => r.id), ["a", "b"]);
  });
});

describe("listActiveChain", () => {
  it("leafId leaf→root, siblings out", async () => {
    const repo = repoWith([
      raw("root", null, "2026-01-01T00:00:00.000Z"),
      raw("b", "root", "2026-01-01T00:00:01.000Z"),
      raw("c", "root", "2026-01-01T00:00:02.000Z"),
      raw("d", "b", "2026-01-01T00:00:03.000Z"),
    ]);
    const chain = await repo.listActiveChain("sid", "d");
    assert.deepEqual(chain.map((r) => r.id), ["root", "b", "d"]);
    const sibling = await repo.listActiveChain("sid", "c");
    assert.deepEqual(sibling.map((r) => r.id), ["root", "c"]);
  });

  it("unknown leaf → [] (сервис маппит в 404)", async () => {
    const repo = repoWith([raw("root", null, "2026-01-01T00:00:00.000Z")]);
    assert.deepEqual(await repo.listActiveChain("sid", "nope"), []);
    assert.deepEqual(await repo.listActiveChain("sid", ""), []);
  });

  it("глубокая ветка: выбирается только ветка-предок, соседние поддеревья out", async () => {
    const repo = repoWith([
      raw("root", null, "2026-01-01T00:00:00.000Z"),
      raw("b", "root", "2026-01-01T00:00:01.000Z"),
      raw("c", "root", "2026-01-01T00:00:02.000Z"),
      raw("d", "b", "2026-01-01T00:00:03.000Z"),
      raw("e", "c", "2026-01-01T00:00:04.000Z"),
    ]);
    assert.deepEqual((await repo.listActiveChain("sid", "e")).map((r) => r.id), ["root", "c", "e"]);
  });
});

describe("listVariants", () => {
  it("дети одного parentId, time-ordered, preview обрезан", async () => {
    const repo = repoWith([
      raw("root", null, "2026-01-01T00:00:00.000Z", "root text"),
      raw("b", "root", "2026-01-01T00:00:02.000Z", "second answer here"),
      raw("c", "root", "2026-01-01T00:00:01.000Z", "first answer here"),
      raw("d", "b", "2026-01-01T00:00:03.000Z", "other branch"),
      raw("x", null, "2026-01-01T00:00:00.000Z", "second root"),
    ]);
    const out = await repo.listVariants("sid", "root");
    assert.deepEqual(out.map((r) => r.childId), ["c", "b"]);
    assert.ok(out.every((r) => r.preview.length > 0 && r.preview.length <= 121));
    assert.ok(out.every((r) => typeof r.createdAt === "string"));
  });

  it("чужой parentId scope: дети другого родителя не светятся", async () => {
    const repo = repoWith([
      raw("root", null, "2026-01-01T00:00:00.000Z"),
      raw("b", "root", "2026-01-01T00:00:01.000Z"),
      raw("d", "b", "2026-01-01T00:00:02.000Z"),
    ]);
    const out = await repo.listVariants("sid", "root");
    assert.deepEqual(out.map((r) => r.childId), ["b"]);
    assert.deepEqual((await repo.listVariants("sid", "ghost")).map((r) => r.childId), []);
  });

  it("null parentId отдаёт корни, длинный текст режется с …", async () => {
    const repo = repoWith([raw("root", null, "2026-01-01T00:00:00.000Z", "x".repeat(500))]);
    const out = await repo.listVariants("sid", null);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.preview.endsWith("…"));
    assert.ok(out[0]!.preview.length <= 121);
  });
});

describe("revertMessages", () => {
  it("boundary + descendants в soft-delete, соседняя ветка жива, ответ — parent", async () => {
    const rows = [
      raw("root", null, "2026-01-01T00:00:00.000Z"),
      raw("b", "root", "2026-01-01T00:00:01.000Z"),
      raw("d", "b", "2026-01-01T00:00:02.000Z"),
      raw("c", "root", "2026-01-01T00:00:03.000Z"),
    ];
    let whereCond: unknown = null;
    let updateCalls = 0;
    const fakeClient = {
      update: () => ({
        set: () => ({
          where: (cond: unknown) => {
            updateCalls += 1;
            whereCond = cond;
            return Promise.resolve([]);
          },
        }),
      }),
    };
    const repo = new SessionHistoryRepository({ client: fakeClient } as never, silentLogger());
    (repo as unknown as Record<string, unknown>).fetchRows = async () => rows.map((r) => ({ ...r }));
    const leaf = await repo.revertMessages("sid", "b");
    assert.equal(leaf, "root");
    assert.equal(updateCalls, 1, "revert обязан один раз soft-delete через update.where");
    const values = referencedValues(whereCond).filter((v) => typeof v === "string") as Array<string>;
    // and(sessionId, inArray(domainId, doomed)): sid + doomed внутри одного cond.
    assert.equal(
      values.filter((v) => v === "sid").length,
      1,
      "sid обязан присутствовать ровно 1 раз в and-cond",
    );
    const candidates = new Set(["root", "b", "c", "d"]);
    const doomed = values.filter((v) => candidates.has(v));
    assert.deepEqual(doomed.sort(), ["b", "d"], "doomed обязан нести boundary + потомков");
    assert.ok(!doomed.includes("c"), "соседняя ветка c обязана выжить (не в doomed)");
    assert.ok(!doomed.includes("root"), "предок root обязан выжить (не в doomed)");
  });

  it("root → null (пустой тред)", async () => {
    const rows = [
      raw("root", null, "2026-01-01T00:00:00.000Z"),
      raw("b", "root", "2026-01-01T00:00:01.000Z"),
    ];
    let whereCond: unknown = null;
    let updateCalls = 0;
    const fakeClient = {
      update: () => ({
        set: () => ({
          where: (cond: unknown) => {
            updateCalls += 1;
            whereCond = cond;
            return Promise.resolve([]);
          },
        }),
      }),
    };
    const repo = new SessionHistoryRepository({ client: fakeClient } as never, silentLogger());
    (repo as unknown as Record<string, unknown>).fetchRows = async () => rows.map((r) => ({ ...r }));
    const leaf = await repo.revertMessages("sid", "root");
    assert.equal(leaf, null);
    assert.equal(updateCalls, 1, "revert root обязан один раз soft-delete через update.where");
    const values = referencedValues(whereCond).filter((v) => typeof v === "string") as Array<string>;
    // and(sessionId, inArray(domainId, doomed)): sid + doomed внутри одного cond.
    assert.equal(
      values.filter((v) => v === "sid").length,
      1,
      "sid обязан присутствовать ровно 1 раз в and-cond",
    );
    const candidates = new Set(["root", "b"]);
    const doomed = values.filter((v) => candidates.has(v));
    assert.deepEqual(doomed.sort(), ["b", "root"], "revert root обязан soft-delete весь тред");
  });

  it("unknown → undefined (сервис маппит в 404)", async () => {
    const repo = repoWith([raw("root", null, "2026-01-01T00:00:00.000Z")]);
    assert.equal(await repo.revertMessages("sid", "nope"), undefined);
  });

  it("hostile: пустой тред и null/undefined/пустой boundary не падают", async () => {
    const empty = repoWith([]);
    assert.equal(await empty.revertMessages("sid", "any"), undefined);
    assert.equal(await empty.revertMessages("sid", ""), undefined);
    const live = repoWith([raw("root", null, "2026-01-01T00:00:00.000Z")]);
    assert.equal(await live.revertMessages("sid", null as unknown as string), undefined);
    assert.equal(await live.revertMessages("sid", undefined as unknown as string), undefined);
  });
});

describe("soft-deleted contract", () => {
  it("contract-only: выдача содержит только живые ряды (fetchRows отсекла deletedAt)", async () => {
    // contract-only: реальный фильтр isNull(deletedAt) живёт в fetchRows/SQL
    // (покрыт session-history.repository.spec.ts:398-422 через fake-drizzle:
    //  deleted_at в cond + drop soft-deleted/foreign — m3 gone, m1/m2 живы);
    // здесь фиксируем контракт: в repoWith попадают только живые — мёртвые
    // никогда не всплывают в chain/variants.
    // в repoWith попадают только живые — мёртвые никогда не всплывают в chain/variants.
    const repo = repoWith([
      raw("root", null, "2026-01-01T00:00:00.000Z"),
      raw("b", "root", "2026-01-01T00:00:01.000Z"),
    ]);
    const msgs = await repo.listMessages("sid");
    assert.deepEqual(msgs.map((r) => r.id), ["root", "b"]);
    const chain = await repo.listActiveChain("sid", "b");
    assert.deepEqual(chain.map((r) => r.id), ["root", "b"]);
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
  console.error(`parentchain checks failed: ${(err as Error).message}`);
  process.exit(1);
});
