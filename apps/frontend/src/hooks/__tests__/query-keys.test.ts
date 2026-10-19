/**
 * query-keys — centralized React Query cache identity (P0 single source).
 *
 * Covers: frozen key shapes (profile/usage/registries/npm), aiProviders
 * scope (`?? 'all'`, empty string stays), re-export identity (same
 * reference as the source hook module, no duplication drift), stability
 * (same input → deep-equal key).
 */
import { describe, expect, test } from 'bun:test';

import {
  NPM_QUERY_KEY,
  PROFILE_QUERY_KEY,
  REGISTRIES_QUERY_KEY,
  USAGE_QUERY_KEY,
  aiProvidersQueryKey,
  ORGANIZATIONS_QUERY_KEY,
  PROJECTS_QUERY_KEY,
  organizationQueryKey,
  orgMembersQueryKey,
  projectQueryKey,
  userQueryKey,
} from '../query-keys';

import { ORGANIZATIONS_QUERY_KEY as ORGS_SOURCE } from '../useOrganizations';
import { PROJECTS_QUERY_KEY as PROJECTS_SOURCE } from '../useProjects';
import { projectQueryKey as projectKeySource } from '../useProject';
import { organizationQueryKey as orgKeySource } from '../useOrganization';
import { orgMembersQueryKey as membersKeySource } from '../useOrgMembers';
import { userQueryKey as userKeySource } from '../useUser';

describe('query-keys', () => {
  test('frozen shapes: profile/usage/registries/npm', () => {
    expect(PROFILE_QUERY_KEY).toEqual(['profile']);
    expect(USAGE_QUERY_KEY).toEqual(['usage']);
    expect(REGISTRIES_QUERY_KEY).toEqual(['registries']);
    expect(NPM_QUERY_KEY).toEqual(['npm', 'status']);
  });

  test('aiProviders scope: nullish → all, empty string stays', () => {
    expect(aiProvidersQueryKey()).toEqual(['ai-providers', 'all']);
    expect(aiProvidersQueryKey(undefined)).toEqual(['ai-providers', 'all']);
    expect(aiProvidersQueryKey('/proj/web')).toEqual(['ai-providers', '/proj/web']);
    // `??` (not `||`): empty string is a real scope, stays as-is.
    expect(aiProvidersQueryKey('')).toEqual(['ai-providers', '']);
  });

  test('re-exports: same reference as source modules (no drift)', () => {
    expect(ORGANIZATIONS_QUERY_KEY).toBe(ORGS_SOURCE);
    expect(PROJECTS_QUERY_KEY).toBe(PROJECTS_SOURCE);
    expect(projectQueryKey).toBe(projectKeySource);
    expect(organizationQueryKey).toBe(orgKeySource);
    expect(orgMembersQueryKey).toBe(membersKeySource);
    expect(userQueryKey).toBe(userKeySource);
  });

  test('stability: same input → deep-equal keys', () => {
    expect(aiProvidersQueryKey('/a')).toEqual(aiProvidersQueryKey('/a'));
    expect(projectQueryKey('id-1')).toEqual(projectQueryKey('id-1'));
    expect(organizationQueryKey('org-1')).toEqual(organizationQueryKey('org-1'));
    expect(orgMembersQueryKey('org-1')).toEqual(orgMembersQueryKey('org-1'));
    expect(userQueryKey('user-1')).toEqual(userQueryKey('user-1'));
    // Different scopes split the cache.
    expect(aiProvidersQueryKey('/a')).not.toEqual(aiProvidersQueryKey('/b'));
  });
});
