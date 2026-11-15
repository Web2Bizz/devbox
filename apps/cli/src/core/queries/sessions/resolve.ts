// core/queries/sessions/resolve — pure mappers + backend fetcher.
// Pure: originBadge/listSessionLines/gridCells have no I/O.
// Fetcher goes through core/backend.ts (resolveBackendUrl + backendApiUrl),
// same base as agents/opencode/backend.ts — no React, no imperative TUI.
import { backendApiUrl, resolveBackendUrl } from "../../backend.js";
import type { GridCell, SessionInfo, SessionOrigin } from "./types.js";

export function originBadge(origin: SessionOrigin): string {
  return origin === "cloud" ? "облако" : "локально";
}

export function sessionTitleOf(session: SessionInfo): string {
  const clean = session.title.trim();
  return clean === "" ? session.id : clean;
}

export function listSessionLines(sessions: SessionInfo[], selected: number): string[] {
  return sessions.map((session, i) => {
    const marker = i === selected ? "› " : "  ";
    return `${marker}${i + 1}. ${sessionTitleOf(session)} [${originBadge(session.origin)}]`;
  });
}

export function gridCells(sessions: SessionInfo[], columns: number): GridCell[][] {
  const cols = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 1;
  const rows: GridCell[][] = [];
  sessions.forEach((session, i) => {
    const row = Math.floor(i / cols);
    if (!rows[row]) rows[row] = [];
    rows[row]?.push({ id: session.id, title: sessionTitleOf(session), badge: originBadge(session.origin) });
  });
  return rows;
}

function asSessionInfo(raw: unknown, index: number): SessionInfo | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return null;
  const titleRaw = typeof rec.title === "string" ? rec.title : `session-${index + 1}`;
  const originRaw = typeof rec.origin === "string" ? rec.origin : "local";
  return { id, title: titleRaw, origin: originRaw === "cloud" ? "cloud" : "local" };
}

export function parseSessionList(payload: unknown): SessionInfo[] {
  const list = Array.isArray(payload) ? payload : (payload as Record<string, unknown>)?.sessions;
  if (!Array.isArray(list)) return [];
  const out: SessionInfo[] = [];
  list.forEach((raw, i) => {
    const info = asSessionInfo(raw, i);
    if (info) out.push(info);
  });
  return out;
}

export type SessionsFetchOpts = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

async function getJson(url: string, opts: SessionsFetchOpts): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response.ok) throw new Error(`[cli] sessions request failed status=${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** List sessions: cached local session stays untouched (GET only, no POST). */
export async function fetchSessions(opts: SessionsFetchOpts = {}): Promise<SessionInfo[]> {
  const base = resolveBackendUrl(opts.env ?? process.env);
  const payload = await getJson(`${backendApiUrl(base)}/session`, opts);
  return parseSessionList(payload);
}

async function sendMethod(url: string, method: string, opts: SessionsFetchOpts): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const response = await fetchImpl(url, { method, signal: controller.signal });
    if (!response.ok) throw new Error(`[cli] sessions request failed status=${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeSession(id: string, opts: SessionsFetchOpts = {}): Promise<void> {
  const base = resolveBackendUrl(opts.env ?? process.env);
  await sendMethod(`${backendApiUrl(base)}/session/${encodeURIComponent(id)}/close`, "POST", opts);
}

export async function deleteSession(id: string, opts: SessionsFetchOpts = {}): Promise<void> {
  const base = resolveBackendUrl(opts.env ?? process.env);
  await sendMethod(`${backendApiUrl(base)}/session/${encodeURIComponent(id)}`, "DELETE", opts);
}
