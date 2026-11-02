import assert from "node:assert/strict";
import type { RequestIdentity } from "../../../../auth/identity.service";
import { ProjectsController } from "../projects.controller";
import { ProjectsService } from "../projects.service";
import { ProjectAccessService } from "../modules/project-access/project-access.service";
import { ChatsService } from "../modules/chats/chats.service";
import { GithubLinkService } from "../modules/github/github-link.service";
import { SessionsService } from "../modules/sessions/sessions.service";

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

const ORG_ID = "123e4567-e89b-12d3-a456-426614174005";
const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174090";
const IDENTITY: RequestIdentity = {
  id: "123e4567-e89b-12d3-a456-426614174001",
  email: "alice@example.com",
  mock: false,
};

type Calls = {
  removed: Array<{ id: string; correlationId?: string }>;
  sessions: Array<string>;
  chats: Array<string>;
  getOrThrow: Array<{ id: string; includeDeleted?: boolean }>;
  belongs: Array<{ orgId: string; projectId: string; includeDeleted?: boolean }>;
};

function makeController() {
  const calls: Calls = {
    removed: [],
    sessions: [],
    chats: [],
    getOrThrow: [],
    belongs: [],
  };
  const project = {
    id: PROJECT_ID,
    orgId: ORG_ID,
    ownerId: IDENTITY.id,
    status: "active",
    deletedAt: null,
  };
  const projects = {
    async getOrThrow(
      id: string,
      _correlationId?: string,
      opts?: { includeDeleted?: boolean },
    ) {
      calls.getOrThrow.push({ id, includeDeleted: opts?.includeDeleted });
      return project;
    },
    async assertProjectBelongsToOrg(
      orgId: string,
      projectId: string,
      _correlationId?: string,
      opts?: { includeDeleted?: boolean },
    ) {
      calls.belongs.push({ orgId, projectId, includeDeleted: opts?.includeDeleted });
      return project;
    },
    async remove(id: string, correlationId?: string) {
      calls.removed.push({ id, correlationId });
    },
  };
  const access = {
    async getRole() {
      return "maintainer";
    },
    async assertProjectAccess() {},
  };
  const sessions = {
    async removeByProject(id: string) {
      calls.sessions.push(id);
    },
  };
  const chats = {
    async removeByProject(id: string) {
      calls.chats.push(id);
    },
  };
  const ctl = new ProjectsController(
    projects as unknown as ProjectsService,
    {} as unknown as GithubLinkService,
    chats as unknown as ChatsService,
    sessions as unknown as SessionsService,
    access as unknown as ProjectAccessService,
  );
  return { ctl, calls };
}

describe("ProjectsController.remove has no cascade of its own", () => {
  it("delegates to ProjectsService.remove only (no chat/session cascade)", async () => {
    const { ctl, calls } = makeController();
    await ctl.remove(PROJECT_ID, IDENTITY, "cid-controller-remove");
    assert.deepEqual(calls.removed, [
      { id: PROJECT_ID, correlationId: "cid-controller-remove" },
    ]);
    assert.deepEqual(
      calls.getOrThrow,
      [{ id: PROJECT_ID, includeDeleted: true }],
      "repeated DELETE must stay idempotent (gate includes deleted rows)",
    );
    assert.deepEqual(calls.sessions, [], "sessions.removeByProject must not run");
    assert.deepEqual(calls.chats, [], "chats.removeByProject must not run");
  });
});

describe("ProjectsController.removeOrgProject has no cascade of its own", () => {
  it("delegates to ProjectsService.remove only (no chat/session cascade)", async () => {
    const { ctl, calls } = makeController();
    await ctl.removeOrgProject(
      ORG_ID,
      PROJECT_ID,
      IDENTITY,
      "cid-controller-remove-org",
    );
    assert.deepEqual(calls.removed, [
      { id: PROJECT_ID, correlationId: "cid-controller-remove-org" },
    ]);
    assert.deepEqual(
      calls.belongs,
      [{ orgId: ORG_ID, projectId: PROJECT_ID, includeDeleted: true }],
      "repeated DELETE must stay idempotent (gate includes deleted rows)",
    );
    assert.deepEqual(calls.sessions, [], "sessions.removeByProject must not run");
    assert.deepEqual(calls.chats, [], "chats.removeByProject must not run");
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
    `projects controller soft-delete checks failed to run: ${(err as Error).message}`,
  );
  process.exit(1);
});
