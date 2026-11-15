'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { SessionMessage } from '@rush-code/contracts';
import {
  buildThreadRows,
  isDuplicateLiveTool,
  mergeTextAndLiveTools,
  revertLeafId,
  selectLeafId,
  toChatEntries,
  toChatMessages,
  type ChatEntry,
  type ChatEntryToolStatus,
} from '../lib/chat-chain';
import { newChatId } from './useChatFrames';

export type UseChatChain = {
  entries: Array<ChatEntry>;
  activeLeafId: string | null;
  activeLeaf: ChatEntry | null;
  textVariants: Array<ChatEntry>;
  variantIndex: number;
  variantCount: number;
  messages: ReturnType<typeof toChatMessages>;
  selectLeaf: (id: string) => void;
  revertTo: (messageId: string) => void;
  entriesRef: MutableRefObject<Array<ChatEntry>>;
  leafIdRef: MutableRefObject<string | null>;
  setEntries: Dispatch<SetStateAction<Array<ChatEntry>>>;
  setLeafId: Dispatch<SetStateAction<string | null>>;
  clearChain: () => void;
  replaceWithHistory: (rows: Array<SessionMessage>) => void;
  mergeHistory: (rows: Array<SessionMessage>) => void;
  appendUserText: (text: string) => string;
  appendAssistantPartial: (partial: string) => string | null;
  appendToolLive: (
    name: string,
    detail: string | undefined,
    status: ChatEntryToolStatus,
    callId?: string,
  ) => boolean;
};

function tipId(entries: Array<ChatEntry>, leafId: string | null): string | null {
  return leafId ?? entries[entries.length - 1]?.id ?? null;
}

/**
 * Unified chain owner: durable text (REST) + live tool (SSE) in one
 * homogeneous `entries` array, `activeLeafId` scopes the branch tip.
 * `messages` is the derived text projection of the active chain
 * (reload parity: linear history renders identically either way).
 */
export function useChatChain(): UseChatChain {
  const [entries, setEntries] = useState<Array<ChatEntry>>([]);
  const [leafId, setLeafId] = useState<string | null>(null);

  const entriesRef = useRef<Array<ChatEntry>>([]);
  entriesRef.current = entries;
  const leafIdRef = useRef<string | null>(null);
  leafIdRef.current = leafId;

  const clearChain = useCallback(() => {
    setEntries([]);
    setLeafId(null);
  }, []);

  const replaceWithHistory = useCallback((rows: Array<SessionMessage>) => {
    const nextText = toChatEntries(rows);
    const lastText = [...nextText].reverse()[0];
    setEntries(nextText);
    setLeafId(lastText ? lastText.id : null);
  }, []);

  const mergeHistory = useCallback((rows: Array<SessionMessage>) => {
    const nextText = toChatEntries(rows);
    // Preserve the live tool sidecar: the merged tip is the last entry
    // (tool when a turn is in flight), not the last durable text — otherwise
    // `buildThreadRows` drops tool children and the timeline blanks on resync.
    const prev = entriesRef.current;
    const merged = mergeTextAndLiveTools(nextText, prev);
    const last = merged[merged.length - 1];
    setEntries(merged);
    setLeafId(last ? last.id : leafIdRef.current);
  }, []);

  const appendUserText = useCallback(
    (text: string): string => {
      const id = newChatId();
      const parent = tipId(entriesRef.current, leafIdRef.current);
      const entry: ChatEntry = {
        id,
        kind: 'text',
        role: 'user',
        text,
        parentId: parent,
        createdAt: new Date().toISOString(),
      };
      setEntries((prev) => [...prev, entry]);
      setLeafId(id);
      return id;
    },
    [],
  );

  const appendAssistantPartial = useCallback((partial: string): string | null => {
    if (!partial) return null;
    const id = newChatId();
    const parent = tipId(entriesRef.current, leafIdRef.current);
    const entry: ChatEntry = {
      id,
      kind: 'text',
      role: 'assistant',
      text: partial,
      parentId: parent,
      createdAt: new Date().toISOString(),
    };
    setEntries((prev) => [...prev, entry]);
    setLeafId(id);
    return id;
  }, []);

  const appendToolLive = useCallback(
    (name: string, detail: string | undefined, status: ChatEntryToolStatus, callId?: string): boolean => {
      // H2: suture by callId — a terminal (`done`/`failed`) flips its own
      // `called`/`progress` row in place (same id, chain links intact)
      // instead of appending a neighbour that would hang as Running forever.
      if ((status === 'done' || status === 'failed') && callId) {
        const refPrev = entriesRef.current;
        for (let index = refPrev.length - 1; index >= 0; index -= 1) {
          const entry = refPrev[index];
          if (
            entry &&
            entry.kind === 'tool' &&
            entry.callId === callId &&
            entry.status !== 'done' &&
            entry.status !== 'failed'
          ) {
            const targetId = entry.id;
            const nextDetail = detail ?? entry.detail;
            setEntries((prev) =>
              prev.map((candidate) =>
                candidate.kind === 'tool' && candidate.id === targetId
                  ? {
                      ...candidate,
                      status,
                      ...(nextDetail ? { detail: nextDetail } : {}),
                      at: Date.now(),
                    }
                  : candidate,
              ),
            );
            setLeafId(targetId);
            return true;
          }
        }
      }
      const parent = tipId(entriesRef.current, leafIdRef.current);
      // Sync burst guard via refs (no stale `appended` flag: the `setEntries`
      // updater runs later, so the return value must come from the current ref).
      if (isDuplicateLiveTool(entriesRef.current, name, status, parent)) return false;
      const toolEntry: ChatEntry = {
        id: newChatId(),
        kind: 'tool',
        name,
        ...(detail ? { detail } : {}),
        status,
        parentId: parent,
        at: Date.now(),
        ...(callId ? { callId } : {}),
      };
      setEntries((prev) => {
        // Race guard: a concurrent burst may have landed between the ref
        // check and this updater — keep the single-landing invariant.
        if (isDuplicateLiveTool(prev, name, status, parent)) return prev;
        return [...prev, toolEntry];
      });
      // Advance the leaf to the tool so `buildThreadRows(...).chain` keeps
      // live tool rows (leaf=text would orphan tools as non-ancestor children
      // and the timeline would blank after the decomposition).
      setLeafId(toolEntry.id);
      return true;
    },
    [],
  );

  const selectLeaf = useCallback((id: string): void => {
    const next = selectLeafId(entriesRef.current, leafIdRef.current, id);
    if (next === leafIdRef.current) return;
    setLeafId(next);
  }, []);

  const revertTo = useCallback((messageId: string): void => {
    const next = revertLeafId(entriesRef.current, leafIdRef.current, messageId);
    if (next === leafIdRef.current) return;
    setLeafId(next);
  }, []);

  // Single source: entries own the order, messages derive from the active
  // chain (reload parity: linear history renders identically either way).
  const thread = useMemo(() => buildThreadRows(entries, leafId), [entries, leafId]);
  const messages = useMemo(() => toChatMessages(thread.chain), [thread.chain]);
  const activeLeaf: ChatEntry | null =
    thread.activeLeafId !== null
      ? (entries.find((e) => e.id === thread.activeLeafId) ?? null)
      : null;
  const textVariants = useMemo(
    () => thread.variants.filter((e) => e.kind === 'text'),
    [thread.variants],
  );
  const rawIndex = textVariants.findIndex((e) => e.id === thread.activeLeafId);

  return {
    entries,
    activeLeafId: thread.activeLeafId,
    activeLeaf,
    textVariants,
    variantIndex: rawIndex < 0 ? 0 : rawIndex,
    variantCount: textVariants.length,
    messages,
    selectLeaf,
    revertTo,
    entriesRef,
    leafIdRef,
    setEntries,
    setLeafId,
    clearChain,
    replaceWithHistory,
    mergeHistory,
    appendUserText,
    appendAssistantPartial,
    appendToolLive,
  };
}
