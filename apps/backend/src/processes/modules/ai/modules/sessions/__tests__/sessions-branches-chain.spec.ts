import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import type { AppLogger } from "@common/logger";
import { SessionsService } from "../sessions.service";
import { SessionsController } from "../sessions.controller";

/**
 * Ветки на уровне service/controller (Фаза 1):
 * - leafId passthrough в listActiveChain + 404 MessageNotFound на unknown leaf
 * - variants: чужой parent 404, null parent (корни) без 404
 * - revert root null + buffer omit parentId/leafId; обычный revert — buffer несёт parentId+leafId
 * - controller: GET messages?leafId, GET variants?parentId, POST revert passthrough
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

const UID = "123e4567-e89b-12d3-a456-426614174001";
const PID = "123e4567-e89b-12d3-a456-426614174003";
const SID = "123e4567-e89b-12d3-a456-426614174010";
const DIR = "/tmp/repos/orgs/u/projects/p/content";

function silentLogger(): AppLogger {
  return { debug() {}, info() {}, log() {}, warn() {}, error() {}, fatal() {} } as unknown as AppLogger;
}

function serviceWith(history: Record<string, unknown>, bufferPushes?: Array<{ type: string; payload: unknown }>): SessionsService {
  const access = {
    resolveProjectDirectory: async (projectId: string): Promise<unknown> => ({ projectId, directory: DIR }),
  };
  const auth = { assertServeUser(): void {} };
  const buffer = {
    push: (type: string, payload: unknown): void => {
      bufferPushes?.push({ type, payload });
    },
  };
  const args: Array<unknown> = [{}, access, auth, history, {}, {}, {}, {}, {}, buffer, undefined, silentLogger()];
  return new SessionsService(...(args as unknown as ConstructorParameters<typeof SessionsService>));
}

function notFoundWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (err: unknown) => {
    if (!(err instanceof NotFoundException)) return false;
    const res = err.getResponse() as { code?: string };
    return res.code === code;
  });
}

describe("SessionsService branches chain", () => {
  it("leafId едет в listActiveChain(sessionId, leafId, projectId); unknown leaf → 404 MessageNotFound", async () => {
    const seen: Array<unknown> = [];
    const svc = serviceWith({
      listActiveChain: async (...args: Array<unknown>) => {
        seen.push(args);
        return [{ id: "root" }, { id: "c" }];
      },
    });
    const out = await svc.listMessages(UID, SID, PID, undefined, undefined, "cid", "c");
    assert.deepEqual(out.map((r) => (r as { id: string }).id), ["root", "c"]);
    assert.equal((seen[0] as Array<unknown>)[0], SID);
    assert.equal((seen[0] as Array<unknown>)[1], "c");
    assert.equal((seen[0] as Array<unknown>)[2], PID);

    const missing = serviceWith({ listActiveChain: async () => [] });
    await notFoundWithCode(missing.listMessages(UID, SID, PID, undefined, undefined, "cid", "nope"), "MessageNotFound");
  });

  it("без leafId читается полный тред (listMessages, не activeChain)", async () => {
    let activeCalls = 0;
    const svc = serviceWith({
      listActiveChain: async () => {
        activeCalls += 1;
        return [];
      },
      listMessages: async () => [{ id: "root" }, { id: "b" }, { id: "c" }],
    });
    const out = await svc.listMessages(UID, SID, PID, undefined, undefined, "cid");
    assert.equal(activeCalls, 0);
    assert.deepEqual(out.map((r) => (r as { id: string }).id), ["root", "b", "c"]);
  });

  it("variants чужого parent → 404 MessageNotFound; null parent (корни) без 404", async () => {
    const svc = serviceWith({
      listMessages: async () => [{ id: "root" }, { id: "c" }],
      listVariants: async () => [{ childId: "c" }],
    });
    const out = await svc.listVariants(UID, SID, PID, "root", "cid");
    assert.equal(out.length, 1);
    await notFoundWithCode(svc.listVariants(UID, SID, PID, "ghost-x", "cid"), "MessageNotFound");

    const roots = serviceWith({
      listMessages: async () => [{ id: "root" }],
      listVariants: async (_sid: unknown, parent: unknown) => {
        assert.equal(parent, null);
        return [{ childId: "root" }];
      },
    });
    assert.equal((await roots.listVariants(UID, SID, PID, null, "cid")).length, 1);
    // undefined parent тоже сводится к null и не требует проверки в треде
    assert.equal((await roots.listVariants(UID, SID, PID, undefined, "cid")).length, 1);
  });

  it("revert root → null + buffer без parentId/leafId", async () => {
    const pushes: Array<{ type: string; payload: unknown }> = [];
    const svc = serviceWith({ revertMessages: async () => null }, pushes);
    const out = await svc.revertMessages(UID, SID, PID, "root", "cid");
    assert.deepEqual(out, { activeLeaf: null });
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]!.type, "session.reverted");
    const payload = pushes[0]!.payload as Record<string, unknown>;
    assert.equal(payload.sessionID, SID);
    assert.equal(payload.messageID, "root");
    assert.ok(!("parentId" in payload), "root revert обязан omit parentId");
    assert.ok(!("leafId" in payload), "root revert обязан omit leafId");
  });

  it("revert ветки → parent + buffer несёт parentId и leafId; unknown → 404", async () => {
    const pushes: Array<{ type: string; payload: unknown }> = [];
    const svc = serviceWith({ revertMessages: async () => "root" }, pushes);
    assert.deepEqual(await svc.revertMessages(UID, SID, PID, "b", "cid"), { activeLeaf: "root" });
    const payload = pushes[0]!.payload as Record<string, unknown>;
    assert.equal(payload.parentId, "root");
    assert.equal(payload.leafId, "root");

    const missing = serviceWith({ revertMessages: async () => undefined });
    await notFoundWithCode(missing.revertMessages(UID, SID, PID, "nope", "cid"), "MessageNotFound");
  });

  it("hostile: пустой leafId ведёт себя как отсутствие (полный тред)", async () => {
    let activeCalls = 0;
    const svc = serviceWith({
      listActiveChain: async () => {
        activeCalls += 1;
        return [];
      },
      listMessages: async () => [{ id: "root" }],
    });
    const out = await svc.listMessages(UID, SID, PID, undefined, undefined, "cid", "");
    assert.equal(activeCalls, 0, "пустой leafId не должен ходить в activeChain");
    assert.equal(out.length, 1);
  });
});

describe("SessionsController branches chain", () => {
  const IDENTITY = { id: "uid-1" } as never;

  it("GET messages прокидывает leafId седьмым аргументом сервиса", async () => {
    let seen: Array<unknown> = [];
    const svc = {
      listMessages: async (...args: Array<unknown>) => {
        seen = args;
        return [{ id: "root" }, { id: "c" }];
      },
    };
    const ctrl = new SessionsController(svc as never);
    const out = (await ctrl.messages(IDENTITY, "sid", "pid", undefined, undefined, "leaf-c", "cid")) as Array<{ id: string }>;
    assert.deepEqual(out.map((r) => r.id), ["root", "c"]);
    assert.equal(seen[6], "leaf-c");
  });

  it("GET messages без leafId прокидывает undefined (полный тред)", async () => {
    let seen: Array<unknown> = [];
    const svc = {
      listMessages: async (...args: Array<unknown>) => {
        seen = args;
        return [{ id: "root" }];
      },
    };
    const ctrl = new SessionsController(svc as never);
    await ctrl.messages(IDENTITY, "sid", "pid", undefined, undefined, undefined, "cid");
    assert.equal(seen[6], undefined);
  });

  it("GET variants прокидывает parentId; POST revert прокидывает body и отвечает leaf", async () => {
    let seenParent: unknown = "unset";
    const variantsSvc = {
      listVariants: async (...args: Array<unknown>) => {
        seenParent = args[3];
        return [{ childId: "b" }];
      },
    };
    const vctrl = new SessionsController(variantsSvc as never);
    const variants = (await vctrl.variants(IDENTITY, "sid", "pid", "root", "cid")) as Array<unknown>;
    assert.equal(variants.length, 1);
    assert.equal(seenParent, "root");

    const revertSvc = {
      revertMessages: async (...args: Array<unknown>) => {
        assert.equal(args[1], "sid");
        assert.equal(args[3], "b");
        return { activeLeaf: "root" };
      },
    };
    const rctrl = new SessionsController(revertSvc as never);
    assert.deepEqual(
      await rctrl.revertMessages(IDENTITY, "sid", { projectId: "pid", messageID: "b" }, "cid"),
      { activeLeaf: "root" },
    );
  });

  it("hostile: variants без parentId едет как null (корни)", async () => {
    let seenParent: unknown = "unset";
    const svc = {
      listVariants: async (...args: Array<unknown>) => {
        seenParent = args[3];
        return [];
      },
    };
    const ctrl = new SessionsController(svc as never);
    await ctrl.variants(IDENTITY, "sid", "pid", undefined, "cid");
    assert.equal(seenParent, null);
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
  console.error(`branches chain checks failed: ${(err as Error).message}`);
  process.exit(1);
});
