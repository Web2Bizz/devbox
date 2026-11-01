/**
 * Project 1:1 contract checks — self-contained runner (no new deps,
 * plain node:assert, no live Postgres).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/organizations/modules/projects/__tests__/project-nested.spec.js`
 *
 * Covers C1: create requires orgId (missing → throws), response carries
 * orgId + status + deletedAt (active + soft-deleted rows validate).
 */
import assert from 'node:assert/strict';
import { createProjectSchema, projectSchema } from '@rush-code/contracts';

const ORG = '123e4567-e89b-12d3-a456-426614174001';

const bad = createProjectSchema.safeParse({ name: 'x' });
assert.equal(bad.success, false, 'create without orgId must fail');

const ok = createProjectSchema.safeParse({ orgId: ORG, name: 'x' });
assert.equal(ok.success, true, 'create with orgId must pass');

function row(status: 'active' | 'deleted') {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    orgId: ORG,
    name: 'x',
    description: null,
    githubOwner: null,
    githubRepo: null,
    githubBranch: null,
    githubUrl: null,
    ownerId: null,
    status,
    deletedAt: status === 'deleted' ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    corrupted: false,
    corruptedReason: null,
  };
}

assert.equal(projectSchema.safeParse(row('active')).success, true);
assert.equal(projectSchema.safeParse(row('deleted')).success, true);

console.log('project-nested.spec: ok (orgId required, status/deletedAt validated)');
