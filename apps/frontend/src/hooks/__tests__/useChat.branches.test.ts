import { describe, expect, test } from 'bun:test';

import { buildThreadRows, toChatEntries } from '../../lib/chat-chain';

function row(
  id: string,
  parentId: string | null,
  createdAt: string,
  type = 'user',
  text = id,
) {
  return { id, type, createdAt, text, parentId };
}

describe('toChatMessages branches', () => {
  test('1 parent → N children: без leaf fallback на последнюю, цепь от root', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
      row('c', 'root', '2026-01-01T00:00:02.000Z'),
      row('d', 'b', '2026-01-01T00:00:03.000Z', 'assistant'),
    ] as never);
    const { chain, activeLeafId } = buildThreadRows(entries);
    expect(activeLeafId).toBe('d');
    expect(chain.map((e) => e.id)).toEqual(['root', 'b', 'd']);
  });

  test('leafId narrows to the active chain (siblings out)', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
      row('c', 'root', '2026-01-01T00:00:02.000Z'),
    ] as never);
    expect(buildThreadRows(entries, 'c').chain.map((e) => e.id)).toEqual(['root', 'c']);
  });

  test('unknown leaf falls back to the last entry (never empty)', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
    ] as never);
    expect(buildThreadRows(entries, 'nope').activeLeafId).toBe('b');
  });

  test('chain walks leaf → root', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
      row('d', 'b', '2026-01-01T00:00:02.000Z', 'assistant'),
    ] as never);
    expect(buildThreadRows(entries, 'd').chain.map((e) => e.id)).toEqual(['root', 'b', 'd']);
    expect(buildThreadRows(entries, 'nope').chain.length).toBeGreaterThan(0);
  });
});
