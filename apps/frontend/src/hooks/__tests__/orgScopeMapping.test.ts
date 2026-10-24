/**
 * Scope-mapping unit — additive `scope` passthrough (ProjectScope user|org).
 *
 * Covers: dto with scope 'org'/'user' lands on Project.scope; dto without
 * scope (old caches) leaves scope undefined — old imports never break.
 */
import { describe, expect, test } from 'bun:test';
import type { Project as ProjectApiDto } from '@rush-code/contracts';
import { mapApiToProject as mapFromList } from '../useProjects';
import { mapApiToProject as mapFromDetail } from '../useProject';

function baseDto(): ProjectApiDto {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'demo',
    description: null,
    githubOwner: null,
    githubRepo: null,
    githubBranch: null,
    githubUrl: null,
    ownerId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    corrupted: false,
    corruptedReason: null,
  };
}

describe('scope mapping (additive, optional)', () => {
  for (const [label, map] of [
    ['useProjects', mapFromList],
    ['useProject', mapFromDetail],
  ] as const) {
    test(`${label}: scope 'org' passes through`, () => {
      const project = map({ ...baseDto(), scope: 'org' });
      expect(project.scope).toBe('org');
    });

    test(`${label}: scope 'user' passes through`, () => {
      const project = map({ ...baseDto(), scope: 'user' });
      expect(project.scope).toBe('user');
    });

    test(`${label}: missing scope stays undefined (old caches valid)`, () => {
      const project = map(baseDto());
      expect(project.scope).toBeUndefined();
      expect(project).toMatchObject({ id: baseDto().id, name: 'demo', corrupted: false });
    });
  }
});
