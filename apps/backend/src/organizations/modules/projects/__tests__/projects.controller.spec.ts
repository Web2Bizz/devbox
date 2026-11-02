import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import type { RequestIdentity } from "../../../../auth/identity.service";
import { ProjectsController } from "../projects.controller";
import type { CreateProjectInput } from "../projects.dto";
import { ProjectsService } from "../projects.service";
import { ProjectAccessService } from "../modules/project-access/project-access.service";
import { GithubLinkService } from "../modules/github/github-link.service";

type Case = { name: string; run: () => Promise<void> | void };

const cases: Case[] = [];
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
const IDENTITY: RequestIdentity = {
  id: "123e4567-e89b-12d3-a456-426614174001",
  email: "alice@example.com",
  mock: false,
};

const BODY: CreateProjectInput = {
  orgId: ORG_ID,
  name: "my-app",
  ownerId: "123e4567-e89b-12d3-a456-426614174099",
};

const CREATED = { id: "123e4567-e89b-12d3-a456-426614174090", name: "my-app" };

type CreateCall = { input: CreateProjectInput; correlationId?: string };

function controller(opts: {
  role: string | null;
  roleError?: Error;
}) {
  const roleCalls: Array<{ orgId: string; userId: string; correlationId?: string }> = [];
  const createCalls: CreateCall[] = [];
  const access = {
    async getRole(orgId: string, userId: string, correlationId?: string) {
      if (opts.roleError) throw opts.roleError;
      roleCalls.push({ orgId, userId, correlationId });
      return opts.role;
    },
    async assertProjectAccess() {},
  };
  const projects = {
    async create(input: CreateProjectInput, correlationId?: string) {
      createCalls.push({ input, correlationId });
      return CREATED;
    },
  };
  const ctl = new ProjectsController(
    projects as unknown as ProjectsService,
    {} as unknown as GithubLinkService,
    access as unknown as ProjectAccessService,
  );
  return { ctl, roleCalls, createCalls };
}

function isOrgAccessDenied(err: unknown): boolean {
  assert.ok(
    err instanceof NotFoundException,
    `expected NotFoundException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 404);
  assert.equal(err.message, `Organization ${ORG_ID} not found`);
  return true;
}

describe("ProjectsController.create organization membership", () => {
  it("rejects creation by a non-member before touching the projects service", async () => {
    const { ctl, roleCalls, createCalls } = controller({ role: null });
    await assert.rejects(
      () => ctl.create(BODY, IDENTITY, "cid-deny"),
      isOrgAccessDenied,
    );
    assert.deepEqual(roleCalls, [
      { orgId: ORG_ID, userId: IDENTITY.id, correlationId: "cid-deny" },
    ]);
    assert.deepEqual(createCalls, [], "no project may be created without membership");
  });

  it("creates the project for a member with the Bearer identity as owner", async () => {
    const { ctl, roleCalls, createCalls } = controller({ role: "maintainer" });
    const result = await ctl.create(BODY, IDENTITY, "cid-allow");
    assert.deepEqual(result, CREATED);
    assert.deepEqual(roleCalls, [
      { orgId: ORG_ID, userId: IDENTITY.id, correlationId: "cid-allow" },
    ]);
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0].input, {
      orgId: ORG_ID,
      name: "my-app",
      ownerId: IDENTITY.id,
    });
    assert.equal(createCalls[0].correlationId, "cid-allow");
  });

  it("propagates a membership lookup failure without creating a project", async () => {
    const outage = new Error("db unavailable");
    const { ctl, createCalls } = controller({ role: null, roleError: outage });
    await assert.rejects(
      () => ctl.create(BODY, IDENTITY, "cid-outage"),
      (err: unknown) => err === outage,
    );
    assert.deepEqual(createCalls, []);
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
  console.error(`projects controller checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
