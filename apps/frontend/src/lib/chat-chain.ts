import type { SessionMessage } from '@rush-code/contracts';

/**
 * Unified chat chain — one homogeneous array for durable REST + live SSE.
 *
 * Definition (plan): message = text|tool homogeneous. Reload before/after
 * identical: the durable text projection never invents rows, live tool rows
 * never enter the text tract. Backend write path untouched — `parentId`/`kind`
 * are additive/optional on the wire (see contracts SessionMessage), the chain
 * only reads them when present and defaults to a linear chain otherwise.
 */

export type ChatEntryText = {
  id: string;
  kind: 'text';
  role: 'user' | 'assistant';
  text: string;
  /** Chain link — null for the root. Linear default when the wire omits it. */
  parentId: string | null;
  createdAt?: string;
};

export type ChatEntryToolStatus = 'called' | 'progress' | 'done' | 'failed';

export type ChatEntryTool = {
  id: string;
  kind: 'tool';
  name: string;
  detail?: string;
  status: ChatEntryToolStatus;
  /** Chain link — the text entry the tool turn belongs to (null = root). */
  parentId: string | null;
  at: number;
  /**
   * H2: stable call identity (frontend-only, never wire).
   * Durable rows carry it in the id (`<parent>:<callID>:called|result`,
   * in-process `callID` uppercase); live rows carry the SSE payload
   * (`data.callID`/`data.callId`/`data.toolCallId`). Pairing key for the
   * called→done upsert/collapse — the linear parentId chain never pairs
   * (every row parents the previous one), name alone over-collapses.
   */
  callId?: string;
};

export type ChatEntry = ChatEntryText | ChatEntryTool;

export type ChatRowMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

type WireMessage = SessionMessage & {
  parentId?: unknown;
  parentID?: unknown;
  kind?: unknown;
};

function readParentId(row: WireMessage): string | null {
  const candidate = row.parentId ?? row.parentID;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * H2: call identity of a durable tool row id.
 * In-process ids are `<parent>:<callID>:called|result` (callID uppercase);
 * the middle segment is the call. Recorder uuid rows carry no call —
 * answer undefined (no pairing, no invention).
 */
export function parseDurableToolCallId(id: string): string | undefined {
  const parts = id.split(':');
  if (parts.length < 3) return undefined;
  const tail = parts[parts.length - 1];
  if (tail !== 'called' && tail !== 'result') return undefined;
  const callId = parts[parts.length - 2];
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined;
}

/**
 * H2: call identity of a live SSE tool frame payload.
 * Checks both casings — in-process puts `callID` (uppercase ID), other
 * harnesses `callId`/`toolCallId`. Guarded read, never throws, never
 * invents: undefined when the frame carries no stable call.
 */
export function readFrameToolCallId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const top: Array<unknown> = [record.callID, record.callId, record.toolCallId];
  for (const candidate of top) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  const nested = record.call;
  if (typeof nested === 'object' && nested !== null) {
    const inner = nested as Record<string, unknown>;
    const nestedCandidates: Array<unknown> = [inner.callID, inner.callId];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  }
  return undefined;
}

/**
 * Durable REST → chain. `SessionMessage` rows with `text: null` and no
 * tool/reasoning kind (shell/compaction/… variants) are skipped — nothing
 * invented client-side. Tool/reasoning rows (kind=tool/reasoning, 0012)
 * become timeline entries with the same parentId chain, so reload
 * before/after is identical to the live trace. Reasoning persists as
 * kind=reasoning on the wire but projects into a kind='tool' entry named
 * 'reasoning' — the thinking UI (collapsed reasoning) vs the tool timeline
 * split on entry.name, not on entry.kind.
 * Without wire `parentId` the chain is linear: each entry parents the
 * previous one, so reload before/after is identical to the old mapping.
 */
export function toChatEntries(rows: Array<SessionMessage>): Array<ChatEntry> {
  const next: Array<ChatEntry> = [];
  let prevId: string | null = null;
  for (const row of rows) {
    const wire = row as WireMessage;
    const parentId = readParentId(wire) ?? prevId;
    const kind: unknown = wire.kind ?? (row.type === 'tool' || row.type === 'reasoning' ? row.type : undefined);
    if (kind === 'tool' || kind === 'reasoning' || row.type === 'tool' || row.type === 'reasoning') {
      const rawStatus: unknown = (wire as Record<string, unknown>).status;
      const status: ChatEntryToolStatus =
        rawStatus === 'called' || rawStatus === 'progress' || rawStatus === 'failed' || rawStatus === 'done'
          ? rawStatus
          : rawStatus === 'started'
            ? 'called'
            : rawStatus === 'delta' || rawStatus === 'ended'
              ? 'done'
              : 'done';
      const rawName: unknown = (wire as Record<string, unknown>).name;
      const rawDetail: unknown = (wire as Record<string, unknown>).detail;
      // H2: suture the call identity from the durable id
      // (`<parent>:<callID>:called|result`) for the called→done pairing.
      const durableCallId = parseDurableToolCallId(row.id);
      next.push({
        id: row.id,
        kind: 'tool',
        name:
          typeof rawName === 'string' && rawName.length > 0
            ? rawName
            : kind === 'reasoning' || row.type === 'reasoning'
              ? 'reasoning'
              : 'tool',
        ...(typeof rawDetail === 'string' && rawDetail.length > 0
          ? { detail: rawDetail }
          : typeof row.text === 'string' && row.text.length > 0
            ? { detail: row.text.slice(0, 500) }
            : {}),
        status,
        parentId,
        at: row.createdAt ? Date.parse(row.createdAt) || Date.now() : Date.now(),
        ...(durableCallId ? { callId: durableCallId } : {}),
      });
      prevId = row.id;
      continue;
    }
    if (row.text === null) continue;
    next.push({
      id: row.id,
      kind: 'text',
      role: row.type === 'assistant' ? 'assistant' : 'user',
      text: row.text,
      parentId,
      createdAt: row.createdAt,
    });
    prevId = row.id;
  }
  // H2: one row per call — drop the in-flight marker when its terminal
  // (same callId) already landed. Done/error render untouched.
  return collapsePairedToolCalls(next);
}

/** Chain → legacy chat rows (adapter: text entries only, order preserved). */
export function toChatMessages(entries: Array<ChatEntry>): Array<ChatRowMessage> {
  const next: Array<ChatRowMessage> = [];
  for (const entry of entries) {
    if (entry.kind !== 'text') continue;
    next.push({ id: entry.id, role: entry.role, text: entry.text });
  }
  return next;
}

/**
 * Linear chain fallback: text rows → chain (no branches). Kept for the
 * linear history path where the wire carries no parentId links.
 * Never invents text, order preserved.
 */
export function messagesToEntries(messages: Array<ChatRowMessage>): Array<ChatEntry> {
  const next: Array<ChatEntry> = [];
  let parentId: string | null = null;
  for (const message of messages) {
    next.push({
      id: message.id,
      kind: 'text',
      role: message.role,
      text: message.text,
      parentId,
    });
    parentId = message.id;
  }
  return next;
}

/** Reasoning lives as a `tool` entry named `reasoning` — UI splits on name. */
export function isReasoningEntry(entry: ChatEntry): boolean {
  return entry.kind === 'tool' && entry.name === 'reasoning';
}

/** Last tool entry of the chain (thinking fallback source, null when none). */
export function lastToolEntry(chain: Array<ChatEntry>): ChatEntryTool | null {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index];
    if (entry && entry.kind === 'tool') return entry;
  }
  return null;
}

/**
 * H2: collapse the in-flight marker when its terminal already landed.
 * The durable projection persists every broadcast (called + done/failed as
 * two kind=tool rows) while the timeline shows one row per call — so a
 * `called`/`progress` marker with the same `callId` as a landed `done`/
 * `failed` is dropped, the terminal stays. Pairing is strictly by callId
 * (the linear parentId chain never pairs — every row parents the previous
 * one; name alone over-collapses across calls). Rows without a callId
 * (recorder uuid rows, legacy frames) are left untouched. `reasoning` is
 * excluded — the thinking trace owns its lifecycle. Pure, order-preserving.
 */
export function collapsePairedToolCalls(entries: Array<ChatEntry>): Array<ChatEntry> {
  const terminalCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'tool' || entry.name === 'reasoning') continue;
    if ((entry.status === 'done' || entry.status === 'failed') && entry.callId) {
      terminalCallIds.add(entry.callId);
    }
  }
  if (terminalCallIds.size === 0) return entries;
  // Chain repair: surviving rows parent through the dropped marker
  // (`done.parentId` is the paired `called` id) — re-link them to the
  // marker's own parent so `buildThreadRows` still walks root→leaf.
  const droppedParent = new Map<string, string | null>();
  for (const entry of entries) {
    if (
      entry.kind === 'tool' &&
      entry.name !== 'reasoning' &&
      entry.status !== 'done' &&
      entry.status !== 'failed' &&
      entry.callId &&
      terminalCallIds.has(entry.callId)
    ) {
      droppedParent.set(entry.id, entry.parentId);
    }
  }
  if (droppedParent.size === 0) return entries;
  const resolveParent = (pid: string | null): string | null => {
    let current = pid;
    const seen = new Set<string>();
    while (current !== null && droppedParent.has(current) && !seen.has(current)) {
      seen.add(current);
      current = droppedParent.get(current) ?? null;
    }
    return current;
  };
  const next: Array<ChatEntry> = [];
  for (const entry of entries) {
    if (droppedParent.has(entry.id)) continue;
    const parentId = resolveParent(entry.parentId);
    next.push(parentId === entry.parentId ? entry : { ...entry, parentId });
  }
  return next;
}

/**
 * Merge durable entries with live sidecar entries (reload/resync parity).
 * REST already carries kind=tool/reasoning chain links (0012) while the
 * sidecar may still hold the live burst of the open turn — merge keeps the
 * durable rows verbatim and appends only the sidecar rows the projection
 * does not carry yet.
 *
 * Namespace split (user-loss guard): `text` and `tool` live in separate
 * dedupe namespaces, mirroring the Vercel AI SDK `useChat` protocol (user
 * ids are client-generated and stable, tool parts stream under part-scoped
 * ids) and LangChain JS streaming (`message.text` vs `message.toolCalls`
 * are independent projections — tool deltas never evict the user message).
 * - user/text rows dedupe ONLY by stable `id` (never by tool content keys,
 *   never against tool rows) — an optimistic `appendUserText` id (`newChatId`)
 *   survives a tool-burst resync until REST confirms it verbatim;
 * - tool rows dedupe by `id` AND by content (`name|status|parentId`) — live
 *   ids are random (`newChatId`) while durable ids are deterministic
 *   (`receipt:callID:called|result`), so id-only dedupe would duplicate the
 *   timeline after every reload/resync.
 * Order: durable verbatim first, then the missing live rows in prev order
 * (optimistic user keeps its parent-before-tools position).
 */
export function mergeTextAndLiveTools(
  textEntries: Array<ChatEntry>,
  prevEntries: Array<ChatEntry>,
): Array<ChatEntry> {
  const durableIds = new Set<string>(textEntries.map((entry) => entry.id));
  const durableToolKeys = new Set<string>(
    textEntries
      .filter(isToolEntry)
      .map((entry) => `${entry.name}|${entry.status}|${entry.parentId ?? ''}`),
  );
  // H2: callId-aware dedupe — the linear parentId chain never matches a
  // live sidecar parent, so a live `called` would otherwise resurrect beside
  // its durable `done`. Same callId+status dedupes across the id change.
  const durableCallKeys = new Set<string>(
    textEntries
      .filter(isToolEntry)
      .filter((entry) => entry.callId)
      .map((entry) => `${entry.callId}|${entry.status}`),
  );
  const liveMissing: Array<ChatEntry> = [];
  for (const entry of prevEntries) {
    if (durableIds.has(entry.id)) continue;
    if (entry.kind === 'tool') {
      if (durableToolKeys.has(`${entry.name}|${entry.status}|${entry.parentId ?? ''}`)) continue;
      if (entry.callId && durableCallKeys.has(`${entry.callId}|${entry.status}`)) continue;
      liveMissing.push(entry);
      continue;
    }
    // Text (user/assistant) namespace: id-only key, never matched against
    // tool content keys. Optimistic rows (random newChatId) stay until the
    // durable projection carries the same stable id verbatim.
    liveMissing.push(entry);
  }
  if (liveMissing.length === 0) return textEntries;
  // H2: a replayed live `called` marker must not resurrect beside its
  // durable `done` — collapse the pair to the single terminal row.
  return collapsePairedToolCalls([...textEntries, ...liveMissing]);
}

/**
 * Live tool burst guard: same tool+status under the same parent lands once
 * (mirrors the throttled `tool` trace rows). Pure — tested, used by the SSE
 * loop instead of an inline predicate. Burst-only: only the most recent
 * tool entry dedups, so a repeated `called` after an intervening
 * `progress`/`done`/other tool still lands (full-history `.some()`
 * overdeduplicates and hides the second invocation of the same tool).
 */
export function isDuplicateLiveTool(
  prev: Array<ChatEntry>,
  name: string,
  status: ChatEntryToolStatus,
  parentId: string | null,
): boolean {
  for (let index = prev.length - 1; index >= 0; index -= 1) {
    const entry = prev[index];
    if (!entry || entry.kind !== 'tool') continue;
    return entry.name === name && entry.status === status && entry.parentId === parentId;
  }
  return false;
}

export function isTextEntry(entry: ChatEntry): entry is ChatEntryText {
  return entry.kind === 'text';
}

export function isToolEntry(entry: ChatEntry): entry is ChatEntryTool {
  return entry.kind === 'tool';
}

export type ThreadChain = {
  /** Ordered root → leaf chain for the active leaf. */
  chain: Array<ChatEntry>;
  activeLeafId: string | null;
  /** Siblings sharing the active leaf parent (branch variants, insertion order). */
  variants: Array<ChatEntry>;
  variantIndex: number;
  variantCount: number;
};

/**
 * Chain-index oracle: resolve the active leaf, walk parentId links to the
 * root, collect branch variants (same parentId). Pure, no I/O, cycle-safe.
 * Unknown/missing leafId falls back to the last entry (reload parity: the
 * visible thread never empties on a stale leaf).
 */
export function buildThreadRows(
  entries: Array<ChatEntry>,
  leafId?: string | null,
): ThreadChain {
  if (entries.length === 0) {
    return { chain: [], activeLeafId: null, variants: [], variantIndex: 0, variantCount: 0 };
  }
  const byId = new Map<string, ChatEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const leaf: ChatEntry | undefined =
    (typeof leafId === 'string' && leafId ? byId.get(leafId) : undefined) ??
    entries[entries.length - 1];
  if (!leaf) {
    return { chain: [], activeLeafId: null, variants: [], variantIndex: 0, variantCount: 0 };
  }
  const chain: Array<ChatEntry> = [];
  const seen = new Set<string>();
  let cursor: ChatEntry | undefined = leaf;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  const parentKey = leaf.parentId;
  const variants = entries.filter((entry) => entry.parentId === parentKey);
  const ordered = variants.length > 0 ? variants : [leaf];
  const variantIndex = Math.max(
    0,
    ordered.findIndex((entry) => entry.id === leaf.id),
  );
  return {
    chain,
    activeLeafId: leaf.id,
    variants: ordered,
    variantIndex,
    variantCount: ordered.length,
  };
}

/** Active leaf entry (null on an empty chain). */
export function getActiveLeaf(
  entries: Array<ChatEntry>,
  leafId?: string | null,
): ChatEntry | null {
  const { chain, activeLeafId } = buildThreadRows(entries, leafId);
  if (activeLeafId === null) return null;
  return chain[chain.length - 1] ?? null;
}

/** Validated leaf selection — unknown ids keep the current leaf (never empty). */
export function selectLeafId(
  entries: Array<ChatEntry>,
  currentLeafId: string | null,
  nextLeafId: string,
): string | null {
  if (entries.some((entry) => entry.id === nextLeafId)) return nextLeafId;
  return currentLeafId;
}

/**
 * Revert oracle — the leaf moves to the parent of the target message
 * (Forward-Only: no entries deleted, variants stay selectable).
 * Unknown target keeps the current leaf.
 */
export function revertLeafId(
  entries: Array<ChatEntry>,
  currentLeafId: string | null,
  messageId: string,
): string | null {
  const target = entries.find((entry) => entry.id === messageId);
  if (!target) return currentLeafId;
  return target.parentId;
}
