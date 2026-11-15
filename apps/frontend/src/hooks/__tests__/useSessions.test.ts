/**
 * useSessions.compareSessionsByActivity — newest-first by last activity.
 *
 * Covers: updatedAt desc wins over createdAt, tie on updatedAt breaks by
 * createdAt desc, full tie breaks by id asc (determinism), identical rows
 * compare 0, empty list sorts to [], and sorting a spread copy never
 * mutates the react-query cache array (input order + reference intact).
 */
import { describe, expect, test } from 'bun:test';
import type { SessionInfo } from '@rush-code/contracts';
import { compareSessionsByActivity } from '../useSessions';

const PROJECT = '123e4567-e89b-12d3-a456-426614174090';

const row = (overrides: Partial<SessionInfo> & { id: string }): SessionInfo =>
  ({
    title: null,
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T11:00:00.000Z',
    directory: '/srv/projects/p1',
    projectId: PROJECT,
    model: null,
    agentId: null,
    status: { type: 'idle' },
    ...overrides,
  }) as SessionInfo;

describe('compareSessionsByActivity', () => {
  test('updatedAt desc wins even when createdAt says otherwise', () => {
    const old = row({ id: 'ses-old', createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-29T11:00:00.000Z' });
    const fresh = row({ id: 'ses-new', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' });
    expect([old, fresh].sort(compareSessionsByActivity).map((session) => session.id)).toEqual(['ses-new', 'ses-old']);
    expect(compareSessionsByActivity(fresh, old)).toBeLessThan(0);
    expect(compareSessionsByActivity(old, fresh)).toBeGreaterThan(0);
  });

  test('tie on updatedAt breaks by createdAt desc', () => {
    const a = row({ id: 'ses-a', createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' });
    const b = row({ id: 'ses-b', createdAt: '2026-10-29T12:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' });
    expect([a, b].sort(compareSessionsByActivity).map((session) => session.id)).toEqual(['ses-b', 'ses-a']);
  });

  test('full tie breaks by id asc; identical rows compare 0', () => {
    const a = row({ id: 'ses-a', createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' });
    const b = row({ id: 'ses-b', createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' });
    expect(compareSessionsByActivity(a, b)).toBeLessThan(0);
    expect(compareSessionsByActivity(b, a)).toBeGreaterThan(0);
    expect(compareSessionsByActivity(a, { ...a })).toBe(0);
    expect([b, a].sort(compareSessionsByActivity).map((session) => session.id)).toEqual(['ses-a', 'ses-b']);
  });

  test('empty list sorts to [] (isEmpty contract)', () => {
    expect(([] as Array<SessionInfo>).sort(compareSessionsByActivity)).toEqual([]);
  });

  test('sorting a spread copy never mutates the cached array', () => {
    const cache: Array<SessionInfo> = [
      row({ id: 'ses-old', updatedAt: '2026-10-29T11:00:00.000Z' }),
      row({ id: 'ses-new', updatedAt: '2026-10-30T00:00:00.000Z' }),
    ];
    const before = [...cache];
    const sorted = [...cache].sort(compareSessionsByActivity);
    // Cache order + reference intact for other consumers; sorted is a new array.
    expect(cache.map((session) => session.id)).toEqual(before.map((session) => session.id));
    expect(sorted).not.toBe(cache);
    expect(sorted.map((session) => session.id)).toEqual(['ses-new', 'ses-old']);
    expect(cache.map((session) => session.id)).toEqual(['ses-old', 'ses-new']);
  });

  test('hostile inputs: null/undefined timestamps fall back without throwing', () => {
    const broken = row({ id: 'ses-broken', updatedAt: undefined as unknown as string });
    const ok = row({ id: 'ses-ok', updatedAt: '2026-10-30T00:00:00.000Z' });
    expect(() => [broken, ok].sort(compareSessionsByActivity)).not.toThrow();
  });
});
