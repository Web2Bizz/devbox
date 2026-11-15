import { describe, expect, test } from 'bun:test';

import {
  buildThreadRows,
  mergeTextAndLiveTools,
  revertLeafId,
  selectLeafId,
  toChatEntries,
  toChatMessages,
  type ChatEntry,
} from '../../lib/chat-chain';

function row(
  id: string,
  parentId: string | null | undefined,
  createdAt: string,
  opts: { type?: string; text?: string | null } = {},
) {
  return {
    id,
    type: opts.type ?? 'user',
    createdAt,
    text: opts.text === undefined ? id : opts.text,
    parentId,
  };
}

/**
 * Цепочка parentId на фронте (unified): единый entries + leafId.
 * - entries+leafId: активная цепь root→leaf, siblings out
 * - chain vs createdAt: ссылки побеждают часы
 * - selectLeafId/revertLeafId — чистые оракулы без сети
 * - hostile: пусто, null/undefined parentId, dangling, цикл, text:null
 */
describe('useChat chain hardening', () => {
  test('rows+leafId: активная цепь, siblings out', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
      row('c', 'root', '2026-01-01T00:00:02.000Z'),
      row('d', 'b', '2026-01-01T00:00:03.000Z'),
    ] as never);
    expect(buildThreadRows(entries, 'd').chain.map((e) => e.id)).toEqual(['root', 'b', 'd']);
    expect(buildThreadRows(entries, 'c').chain.map((e) => e.id)).toEqual(['root', 'c']);
  });

  test('chain побеждает createdAt: ссылки важнее порядка в массиве', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:02.000Z'),
      row('b', 'root', '2026-01-01T00:00:00.000Z'),
      row('c', 'b', '2026-01-01T00:00:01.000Z'),
    ] as never);
    const out = buildThreadRows(entries, 'c').chain;
    expect(out.map((e) => e.id)).toEqual(['root', 'b', 'c']);
    expect(out[0]?.id).toBe('root');
  });

  test('1→N без leaf: fallback на последнюю запись, root первый в цепи', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:02.000Z'),
      row('c', 'root', '2026-01-01T00:00:01.000Z'),
      row('d', 'b', '2026-01-01T00:00:03.000Z'),
    ] as never);
    const { chain, activeLeafId } = buildThreadRows(entries);
    expect(activeLeafId).toBe('d');
    expect(chain.map((e) => e.id)).toEqual(['root', 'b', 'd']);
  });

  test('unknown leaf → fallback на последнюю (фронт-фолбэк, не пусто)', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
    ] as never);
    expect(buildThreadRows(entries, 'nope').activeLeafId).toBe('b');
    expect(buildThreadRows(entries, 'nope').chain.map((e) => e.id)).toEqual(['root', 'b']);
  });

  test('selectLeafId scope: unknown сохраняет текущий leaf', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
      row('d', 'b', '2026-01-01T00:00:02.000Z'),
    ] as never);
    expect(selectLeafId(entries, 'b', 'd')).toBe('d');
    expect(selectLeafId(entries, 'd', 'ghost')).toBe('d');
  });

  test('revertLeafId: leaf движется к родителю цели (Forward-Only)', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
    ] as never);
    expect(revertLeafId(entries, 'b', 'b')).toBe('root');
    expect(revertLeafId(entries, 'b', 'ghost')).toBe('b');
  });

  test('revert root даёт null-leaf (пустой тред после отката корня)', () => {
    const entries = toChatEntries([row('root', null, '2026-01-01T00:00:00.000Z')] as never);
    expect(buildThreadRows(entries, 'root').chain.map((e) => e.id)).toEqual(['root']);
    expect(revertLeafId(entries, 'root', 'root')).toBeNull();
  });

  test('mergeTextAndLiveTools: sidecar сохраняется, текст чистый', () => {
    const nextText = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('b', 'root', '2026-01-01T00:00:01.000Z'),
    ] as never);
    const liveTool: ChatEntry = {
      id: 't1',
      kind: 'tool',
      name: 'read',
      status: 'called',
      parentId: 'b',
      at: 1700000002000,
    };
    const merged = mergeTextAndLiveTools(nextText, [...nextText, liveTool]);
    expect(merged.length).toBe(nextText.length + 1);
    expect(toChatMessages(merged)).toEqual(toChatMessages(nextText));
  });

  test('text:null ряды пропускаются, но цепь не рвётся', () => {
    const entries = toChatEntries([
      row('root', null, '2026-01-01T00:00:00.000Z'),
      row('shell', 'root', '2026-01-01T00:00:01.000Z', { type: 'shell', text: null }),
      row('c', 'root', '2026-01-01T00:00:02.000Z'),
    ] as never);
    expect(entries.map((e) => e.id).sort()).toEqual(['c', 'root']);
  });

  test('hostile: пусто / dangling / цикл без падений', () => {
    expect(buildThreadRows([], 'x').chain).toEqual([]);
    const single = toChatEntries([row('only', null, '2026-01-01T00:00:00.000Z')] as never);
    expect(buildThreadRows(single, 'only').chain.map((e) => e.id)).toEqual(['only']);
    const cycle: Array<ChatEntry> = [
      { id: 'a', kind: 'text', role: 'user', text: 'a', parentId: 'b' },
      { id: 'b', kind: 'text', role: 'assistant', text: 'b', parentId: 'a' },
    ];
    expect(buildThreadRows(cycle, 'b').chain.length).toBe(2);
  });
});
