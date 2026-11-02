import assert from "node:assert/strict";
import { UnauthorizedException } from "@nestjs/common";
import type { WorkspacePathService } from "../../../../../../common/storage/workspace-path.service";
import type { ProjectAccessService } from "../../project-access/project-access.service";
import type { ProjectsService } from "../../../projects.service";
import { ProjectFilesService } from "../project-files.service";

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
const REQUESTER_ID = "123e4567-e89b-12d3-a456-426614174002";

const silentLogger = {
  debug() {},
  info() {},
  log() {},
  warn() {},
  error() {},
  fatal() {},
} as unknown as ConstructorParameters<typeof ProjectFilesService>[2];

const project = { id: PROJECT_ID, ownerId: OWNER_ID } as unknown as Awaited<
  ReturnType<ProjectsService["getOrThrow"]>
>;

function makeService(opts: { wired: boolean }) {
  const accessCalls: Array<{ projectId: string; ownerId: string | null; requesterId: string }> = [];
  const fsCalls: Array<string> = [];
  const projectsCalls: Array<string> = [];
  const projects = {
    async getOrThrow(projectId: string) {
      projectsCalls.push(projectId);
      return project;
    },
  } as unknown as ProjectsService;
  const paths = {
    async resolveUser(userId: string, projectId: string, subPath: string) {
      fsCalls.push(`resolveUser:${userId}:${projectId}:${subPath}`);
      return { abs: "/tmp/project-content", rel: "." };
    },
    async readDir(abs: string) {
      fsCalls.push(`readDir:${abs}`);
      return [];
    },
    async statPath(abs: string) {
      fsCalls.push(`statPath:${abs}`);
      return null;
    },
  } as unknown as WorkspacePathService;
  const access = {
    async assertProjectAccess(
      projectId: string,
      ownerId: string | null,
      requesterId: string,
    ) {
      accessCalls.push({ projectId, ownerId, requesterId });
    },
  } as unknown as ProjectAccessService;
  const svc = opts.wired
    ? new ProjectFilesService(projects, paths, silentLogger, access)
    : new (ProjectFilesService as unknown as new (
        ...args: Array<unknown>
      ) => ProjectFilesService)(projects, paths, silentLogger);
  return { svc, accessCalls, fsCalls, projectsCalls };
}

function isUnauthorized(err: unknown): boolean {
  assert.ok(
    err instanceof UnauthorizedException,
    `expected UnauthorizedException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 401);
  const body = err.getResponse() as { code?: string };
  assert.equal(body.code, "unauthorized");
  return true;
}

describe("ProjectFilesService access is fail-closed", () => {
  it("tree() without a requester → 401 before any access/fs call", async () => {
    const { svc, accessCalls, fsCalls } = makeService({ wired: true });
    await assert.rejects(
      () => svc.tree(PROJECT_ID, ".", 1, "cid-files-no-requester"),
      isUnauthorized,
    );
    assert.deepEqual(accessCalls, []);
    assert.deepEqual(fsCalls, []);
  });

  it("tree() with an empty requester → 401 before any access/fs call", async () => {
    const { svc, accessCalls, fsCalls } = makeService({ wired: true });
    await assert.rejects(
      () => svc.tree(PROJECT_ID, ".", 1, "cid-files-empty-requester", ""),
      isUnauthorized,
    );
    assert.deepEqual(accessCalls, []);
    assert.deepEqual(fsCalls, []);
  });

  it("tree() with a requester but no access dependency must not silently skip the gate", async () => {
    const { svc, fsCalls } = makeService({ wired: false });
    await assert.rejects(
      () => svc.tree(PROJECT_ID, ".", 1, "cid-files-no-access", REQUESTER_ID),
    );
    assert.deepEqual(fsCalls, []);
  });

  it("tree() with a requester checks project access before reading disk (regression)", async () => {
    const { svc, accessCalls, fsCalls } = makeService({ wired: true });
    const node = await svc.tree(
      PROJECT_ID,
      ".",
      1,
      "cid-files-allowed",
      REQUESTER_ID,
    );
    assert.equal(node.type, "dir");
    assert.deepEqual(accessCalls, [
      { projectId: PROJECT_ID, ownerId: OWNER_ID, requesterId: REQUESTER_ID },
    ]);
    assert.ok(fsCalls.length > 0);
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`project files checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
