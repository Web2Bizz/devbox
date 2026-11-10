import assert from "node:assert/strict";
import { UnauthorizedException } from "@nestjs/common";
import type { DbService } from "@common/db/db.service";
import type { ProjectAccessService } from "../../project-access/project-access.service";
import type { ProjectsService } from "../../../projects.service";
import { ChatsService } from "../chats.service";

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

const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174090";
const OWNER_ID = "123e4567-e89b-12d3-a456-426614174001";

const silentLogger = {
  debug() {},
  info() {},
  log() {},
  warn() {},
  error() {},
  fatal() {},
} as unknown as ConstructorParameters<typeof ChatsService>[1];

const project = { id: PROJECT_ID, ownerId: OWNER_ID } as unknown as Awaited<
  ReturnType<ProjectsService["getOrThrow"]>
>;

function makeService() {
  const accessCalls: Array<{ projectId: string; requesterId: string }> = [];
  const projects = {
    async getOrThrow() {
      return project;
    },
  } as unknown as ProjectsService;
  const access = {
    async assertProjectAccess(
      projectId: string,
      _ownerId: string | null,
      requesterId: string,
    ) {
      accessCalls.push({ projectId, requesterId });
    },
  } as unknown as ProjectAccessService;
  const untouchedDb = {
    get client(): never {
      throw new Error("db-touched");
    },
  } as unknown as DbService;
  return {
    svc: new ChatsService(projects, silentLogger, untouchedDb, access),
    accessCalls,
  };
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof UnauthorizedException;
}

describe("ChatsService access is fail-closed", () => {
  it("list() without a requester → 401 before any DB/access call", async () => {
    const { svc, accessCalls } = makeService();
    await assert.rejects(
      () => svc.list(PROJECT_ID, "cid-chats-list"),
      isUnauthorized,
    );
    assert.deepEqual(accessCalls, []);
  });

  it("create() without a requester → 401", async () => {
    const { svc, accessCalls } = makeService();
    await assert.rejects(
      () => svc.create(PROJECT_ID, { title: "chat" }, "cid-chats-create"),
      isUnauthorized,
    );
    assert.deepEqual(accessCalls, []);
  });

  it("remove() without a requester → 401", async () => {
    const { svc, accessCalls } = makeService();
    await assert.rejects(
      () =>
        svc.remove(
          PROJECT_ID,
          "123e4567-e89b-12d3-a456-426614174092",
          "cid-chats-remove",
        ),
      isUnauthorized,
    );
    assert.deepEqual(accessCalls, []);
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
  console.error(`chats access checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
