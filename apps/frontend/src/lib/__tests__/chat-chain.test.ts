import { describe, expect, test } from 'bun:test';

import {
  buildThreadRows,
  isDuplicateLiveTool,
  mergeTextAndLiveTools,
  revertLeafId,
  selectLeafId,
  toChatEntries,
  toChatMessages,
  type ChatEntry,
} from '../chat-chain';

const row = (id: string, type: string, text: string | null, parentId?: string | null) => ({
  id,
  type,
  createdAt: new Date(1700000000000).toISOString(),
  text,
  ...(parentId !== undefined ? { parentId } : {}),
});

describe('chat-chain oracle', () => {
  test('durable: text rows map linearly, null variants skipped', () => {
    const entries = toChatEntries([
      row('m1', 'user', 'hi'),
      row('m2', 'shell', null),
      row('m3', 'assistant', 'hello back'),
    ]);
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ id: 'm1', kind: 'text', parentId: null });
    expect(entries[1]).toMatchObject({ id: 'm3', kind: 'text', parentId: 'm1' });
    expect(toChatMessages(entries)).toEqual([
      { id: 'm1', role: 'user', text: 'hi' },
      { id: 'm3', role: 'assistant', text: 'hello back' },
    ]);
  });

  test('branches: same parentId are variants, chain follows the active leaf', () => {
    const entries = toChatEntries([row('m1', 'user', 'q'), row('m2', 'assistant', 'a1')]);
    const fork = {
      id: 'm3',
      kind: 'text' as const,
      role: 'assistant' as const,
      text: 'a2',
      parentId: 'm1',
      createdAt: new Date(1700000001000).toISOString(),
    };
    const branched = [...entries, fork];
    const first = buildThreadRows(branched, 'm2');
    expect(first.chain.map((e) => e.id)).toEqual(['m1', 'm2']);
    expect(first.variantCount).toBe(2);
    const second = buildThreadRows(branched, 'm3');
    expect(second.chain.map((e) => e.id)).toEqual(['m1', 'm3']);
    expect(selectLeafId(branched, 'm2', 'm3')).toBe('m3');
    expect(selectLeafId(branched, 'm2', 'unknown')).toBe('m2');
    expect(revertLeafId(branched, 'm3', 'm3')).toBe('m1');
  });

  test('reload parity: before/after identical for linear history', () => {
    const rows = [row('m1', 'user', 'hi'), row('m2', 'assistant', 'hello')];
    const before = toChatMessages(toChatEntries(rows));
    const reloaded = toChatMessages(buildThreadRows(toChatEntries(rows), 'm2').chain);
    expect(reloaded).toEqual(before);
  });

  test('tool entries: text projection filters tools, chain keeps live parent', () => {
    const text = toChatEntries([row('m1', 'user', 'q'), row('m2', 'assistant', 'a1')]);
    const tool: ChatEntry = {
      id: 't1',
      kind: 'tool',
      name: 'read',
      detail: 'called',
      status: 'called',
      parentId: 'm2',
      at: 1700000002000,
    };
    const entries = [...text, tool];
    expect(toChatMessages(entries)).toEqual([
      { id: 'm1', role: 'user', text: 'q' },
      { id: 'm2', role: 'assistant', text: 'a1' },
    ]);
    const live = buildThreadRows(entries, 't1');
    expect(live.chain.map((e) => e.id)).toEqual(['m1', 'm2', 't1']);
    const textLeaf = buildThreadRows(entries, 'm2');
    expect(textLeaf.chain.map((e) => e.id)).toEqual(['m1', 'm2']);
  });

  test('tool burst: same tool+status+parent lands once', () => {
    const prev: Array<ChatEntry> = [
      {
        id: 't1',
        kind: 'tool',
        name: 'read',
        status: 'called',
        parentId: 'm1',
        at: 1,
      },
    ];
    expect(isDuplicateLiveTool(prev, 'read', 'called', 'm1')).toBe(true);
    expect(isDuplicateLiveTool(prev, 'read', 'progress', 'm1')).toBe(false);
    expect(isDuplicateLiveTool(prev, 'write', 'called', 'm1')).toBe(false);
    expect(isDuplicateLiveTool(prev, 'read', 'called', 'm2')).toBe(false);
    expect(isDuplicateLiveTool([], 'read', 'called', 'm1')).toBe(false);
  });

  test('tool burst-only: repeated called after progress/done still lands', () => {
    const called: Array<ChatEntry> = [
      { id: 't1', kind: 'tool', name: 'bash', status: 'called', parentId: 'm1', at: 1 },
    ];
    const progressed: Array<ChatEntry> = [
      ...called,
      { id: 't2', kind: 'tool', name: 'bash', status: 'progress', parentId: 'm1', at: 2 },
    ];
    const done: Array<ChatEntry> = [
      ...progressed,
      { id: 't3', kind: 'tool', name: 'bash', status: 'done', parentId: 'm1', at: 3 },
    ];
    // Immediate burst duplicates once …
    expect(isDuplicateLiveTool(called, 'bash', 'called', 'm1')).toBe(true);
    // … but the lifecycle called → progress → done each lands …
    expect(isDuplicateLiveTool(called, 'bash', 'progress', 'm1')).toBe(false);
    expect(isDuplicateLiveTool(progressed, 'bash', 'done', 'm1')).toBe(false);
    // … and a second invocation after done is not overdeduplicated.
    expect(isDuplicateLiveTool(done, 'bash', 'called', 'm1')).toBe(false);
    const secondCalled: Array<ChatEntry> = [
      ...done,
      { id: 't4', kind: 'tool', name: 'bash', status: 'called', parentId: 'm1', at: 4 },
    ];
    expect(isDuplicateLiveTool(secondCalled, 'bash', 'called', 'm1')).toBe(true);
  });

  test('stale/unknown leaf falls back to the last entry, empty stays empty', () => {
    const entries = toChatEntries([row('m1', 'user', 'hi'), row('m2', 'assistant', 'yo')]);
    expect(buildThreadRows(entries, 'unknown').activeLeafId).toBe('m2');
    expect(buildThreadRows(entries, null).activeLeafId).toBe('m2');
    expect(buildThreadRows(entries, undefined).activeLeafId).toBe('m2');
    expect(buildThreadRows(entries, 'unknown').chain.map((e) => e.id)).toEqual(['m1', 'm2']);
    const empty = buildThreadRows([], 'unknown');
    expect(empty.chain).toEqual([]);
    expect(empty.activeLeafId).toBeNull();
  });

  test('cycle-safe: parent loop terminates without duplication', () => {
    const a: ChatEntry = {
      id: 'a',
      kind: 'text',
      role: 'user',
      text: 'a',
      parentId: 'b',
    };
    const b: ChatEntry = {
      id: 'b',
      kind: 'text',
      role: 'assistant',
      text: 'b',
      parentId: 'a',
    };
    const res = buildThreadRows([a, b], 'b');
    expect(res.chain.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(new Set(res.chain.map((e) => e.id)).size).toBe(res.chain.length);
  });

  test('wire compat: parentID (capital D) is honored', () => {
    const rows = [
      row('m1', 'user', 'hi'),
      {
        ...row('m2', 'assistant', 'yo'),
        parentID: 'm1',
      },
    ] as unknown as Array<Parameters<typeof toChatEntries>[number]>;
    const entries = toChatEntries(rows);
    expect(entries[1]).toMatchObject({ id: 'm2', parentId: 'm1' });
    expect(buildThreadRows(entries, 'm2').chain.map((e) => e.id)).toEqual(['m1', 'm2']);
  });

  test('variants keep insertion order with stable indexes', () => {
    const base = toChatEntries([row('m1', 'user', 'q')]);
    const mk = (id: string): ChatEntry => ({
      id,
      kind: 'text',
      role: 'assistant',
      text: id,
      parentId: 'm1',
    });
    const entries = [...base, mk('m2'), mk('m3'), mk('m4')];
    const res = buildThreadRows(entries, 'm3');
    expect(res.variants.map((e) => e.id)).toEqual(['m2', 'm3', 'm4']);
    expect(res.variantIndex).toBe(1);
    expect(res.variantCount).toBe(3);
    expect(buildThreadRows(entries, 'm4').variantIndex).toBe(2);
  });

  test('reload parity with live tools: merge preserves sidecar, text stays clean', () => {
    const rows = [row('m1', 'user', 'hi'), row('m2', 'assistant', 'hello')];
    const nextText = toChatEntries(rows);
    const liveTool: ChatEntry = {
      id: 't1',
      kind: 'tool',
      name: 'read',
      status: 'called',
      parentId: 'm2',
      at: 1700000002000,
    };
    const merged = mergeTextAndLiveTools(nextText, [...nextText, liveTool]);
    expect(merged.length).toBe(nextText.length + 1);
    expect(merged[merged.length - 1]).toMatchObject({ id: 't1', kind: 'tool' });
    expect(toChatMessages(merged)).toEqual(toChatMessages(nextText));
    expect(toChatMessages(buildThreadRows(merged, 'm2').chain)).toEqual(
      toChatMessages(nextText),
    );
    expect(mergeTextAndLiveTools(nextText, nextText)).toBe(nextText);
  });
});
