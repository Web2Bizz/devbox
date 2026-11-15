/**
 * Status-mapping unit — soft-delete maps to archived (deleted rows are
 * invisible by default, member-visible via ?includeDeleted).
 */
import { describe, expect, test } from 'bun:test';
import type { Project as ProjectApiDto } from '@rush-code/contracts';
import { mapApiToProject as mapFromList } from '../useProjects';
import { mapApiToProject as mapFromDetail } from '../useProject';

function baseDto(): ProjectApiDto {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    orgId: '22222222-2222-2222-2222-222222222222',
    name: 'demo',
    description: null,
    githubOwner: null,
    githubRepo: null,
    githubBranch: null,
    githubUrl: null,
    ownerId: null,
    status: 'active',
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    corrupted: false,
    corruptedReason: null,
  };
}

describe('status mapping (soft-delete)', () => {
  for (const [label, map] of [
    ['useProjects', mapFromList],
    ['useProject', mapFromDetail],
  ] as const) {
    test(`${label}: active stays active`, () => {
      const project = map({ ...baseDto(), status: 'active' });
      expect(project.status).toBe('active');
    });

    test(`${label}: deleted maps to archived`, () => {
      const project = map({ ...baseDto(), status: 'deleted' });
      expect(project.status).toBe('archived');
    });
  }
});
