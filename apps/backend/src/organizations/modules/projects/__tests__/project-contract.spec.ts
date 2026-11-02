import assert from 'node:assert/strict';
import { createProjectSchema, projectSchema } from '@rush-code/contracts';

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite = '';

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = '';
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

const PROJECT_ID = '123e4567-e89b-12d3-a456-426614174090';
const ORG_ID = '123e4567-e89b-12d3-a456-426614174005';

/** Minimal wire Project (all fields projectSchema requires). */
function project(orgId: string | null) {
  return {
    id: PROJECT_ID,
    orgId,
    name: 'my-app',
    description: null,
    githubOwner: null,
    githubRepo: null,
    githubBranch: null,
    githubUrl: null,
    ownerId: null,
    status: 'active',
    deletedAt: null,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    corrupted: false,
    corruptedReason: null,
  };
}

describe('projectSchema.orgId (C5 contract)', () => {
  it('accepts an org-linked project (orgId: uuid)', () => {
    const parsed = projectSchema.safeParse(project(ORG_ID));
    assert.equal(parsed.success, true, 'org-linked project must validate');
  });

  it('accepts a user-space project (orgId: null)', () => {
    const parsed = projectSchema.safeParse(project(null));
    assert.equal(parsed.success, true, 'user-space project (orgId null) must validate');
  });
});

describe('createProjectSchema.orgId (C5 contract)', () => {
  it('still requires orgId on create', () => {
    const parsed = createProjectSchema.safeParse({ name: 'my-app' });
    assert.equal(parsed.success, false, 'orgId must stay required on create');
  });

  it('rejects orgId: null on create (nullable is response-only)', () => {
    const parsed = createProjectSchema.safeParse({ orgId: null, name: 'my-app' });
    assert.equal(parsed.success, false, 'create must not accept a null orgId');
  });

  it('accepts a create body with orgId', () => {
    const parsed = createProjectSchema.safeParse({ orgId: ORG_ID, name: 'my-app' });
    assert.equal(parsed.success, true, 'create with orgId must validate');
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
  console.error(`project contract checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
