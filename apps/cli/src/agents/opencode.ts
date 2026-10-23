// agents/opencode — OpenCode chat client (key + fetch, no UI, no console.*).
// Key order (canonical, mirrors tools/classify_build.ts):
// env OPENCODE_API_KEY||JEV_API_KEY → fallback auth.json
// ($HOME/.local/share/opencode/auth.json, XDG_DATA_HOME override,
// JSON {opencode:{key}, opencode-go:{key}} — .opencode-go.key || .opencode.key).
// Missing → fail-fast missing OPENCODE_API_KEY. Secrets never in messages.
// Cloud base is hard-coded (user-approved); only the base URL (never the key)
// may be overridden via explicit OPENCODE_API_BASE_URL env.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENCODE_TIMEOUT_MS = 30_000;
export const OPENCODE_CAUSE_MAX = 2000;

/**
 * Cloud API base URL — hard-coded (explicitly user-approved, never from
 * auth.json, never derived). NOTE: NOT api.opencode.ai — that host is a
 * catch-all returning 200 `Not Found` (see
 * apps/backend/src/opencode-keys/opencode-billing.service.ts live-probe
 * doc: real Cloud host is opencode.ai, e.g. Zen Go
 * https://opencode.ai/zen/go/v1/usage). Override (explicit only, for
 * stage/dev): OPENCODE_API_BASE_URL env.
 *
 * v2 source: official OpenAPI v2 (https://opencode.ai/v2/docs/api,
 * /v2/openapi.json) describes the LOCAL instance HttpApi only — it has NO
 * billing/chat surface (see billing.service.ts:105-123 + e2e:429-430).
 * The proven live Cloud inference path is
 * POST https://opencode.ai/inference/systemone/v1/systemone with
 * {model:"jev-1.13-free", state, questions} + Bearer → 200
 * (see .opencode/tools/classify_build.ts; 404 HTML = wrong path,
 * 401 JSON = live endpoint without key). This client reuses that v2
 * contract — it never invents /v1/chat.
 */
export const OPENCODE_API_BASE_URL = "https://opencode.ai";

/**
 * Cloud inference path on the base (always joined via new URL(path, base)).
 * v2 systemone (see comment above) — NOT /v1/chat (404 HTML catch-all).
 */
export const OPENCODE_CHAT_PATH = "/inference/systemone/v1/systemone";

/** Default model for the v2 systemone contract (free, same key as /connect). */
export const OPENCODE_DEFAULT_MODEL = "jev-1.13-free";

export const MISSING_KEY_MESSAGE =
  "[cli] missing OPENCODE_API_KEY → задай env или auth.json " +
  "(export OPENCODE_API_KEY=<ключ из консоли> либо /connect в TUI, см. apps/cli/.env.example).";

/** Auth file path ($HOME/.local/share/opencode/auth.json, XDG_DATA_HOME override). */
export function opencodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.XDG_DATA_HOME ?? "").trim();
  const dataDir = override || path.join(os.homedir(), ".local", "share");
  return path.join(dataDir, "opencode", "auth.json");
}

/** Resolve key or throw fail-fast (never returns empty, never logs the value). */
export function getOpencodeKey(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.OPENCODE_API_KEY || env.JEV_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(opencodeAuthPath(env), "utf8");
    const parsed = JSON.parse(raw) as Record<string, { key?: unknown } | undefined>;
    const candidate = parsed?.["opencode-go"]?.key ?? parsed?.opencode?.key ?? "";
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  } catch {
    // ENOENT / parse errors → ignore, fail-fast below (no silent fallback).
  }
  throw new Error(MISSING_KEY_MESSAGE);
}

/** True when a key resolves (env or auth.json), false otherwise (no throw). */
export function hasOpencodeKey(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return getOpencodeKey(env).length > 0;
  } catch {
    return false;
  }
}

/** Scrub live secrets (Bearer, basic-auth URLs) → [redacted]. */
export function scrubOpencodeText(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s"']+/g, "$1[redacted]")
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@]+:)[^@\s/]+"?@/g, "$1[redacted]@")
    .replace(/:\/\/([^/\s:]+):([^@\s/]+)@/g, "://$1:[redacted]@");
}

function scrubCause(text: string): string {
  return scrubOpencodeText(text).slice(0, OPENCODE_CAUSE_MAX);
}

export type ChatOpencodeOptions = {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function resolveBaseUrl(env: NodeJS.ProcessEnv): string {
  // Explicit override only (never a silent fallback): primary
  // OPENCODE_API_BASE_URL, legacy OPENCODE_BASE_URL kept for compat.
  const custom = (env.OPENCODE_API_BASE_URL ?? "").trim() || (env.OPENCODE_BASE_URL ?? "").trim();
  if (custom) return custom;
  return OPENCODE_API_BASE_URL;
}

/** Chat endpoint: OPENCODE_CHAT_PATH joined onto the base (never relative). */
export function resolveChatEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(OPENCODE_CHAT_PATH, resolveBaseUrl(env)).toString();
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function extractReplyText(payload: unknown, fallbackText: string): string {
  if (typeof payload === "string") return payload;
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    // v2 systemone shape: {answers: {<name>: {choice, confidence, ...}}} —
    // return the first non-empty choice (see classify_build.ts).
    const answers = record["answers"];
    if (answers !== null && typeof answers === "object") {
      const entries = answers as Record<string, unknown>;
      for (const key of Object.keys(entries)) {
        const entry = entries[key];
        if (entry !== null && typeof entry === "object") {
          const choice = (entry as Record<string, unknown>)["choice"];
          if (typeof choice === "string" && choice.trim()) return choice;
        }
      }
    }
    for (const key of ["text", "message", "content", "reply"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return fallbackText;
}

/**
 * POST {model, state, questions} with Bearer key (timeout 30s, 1 retry on network/5xx/429).
 * v2 systemone contract (see OPENCODE_CHAT_PATH comment): state carries the
 * user prompt, questions.reply is a single choice question; the reply is
 * answers.reply.choice (legacy {text/message/content/reply} still accepted
 * for mocks/back-compat). Throws scrubbed errors (cause ≤2000 chars,
 * secrets → [redacted]). No console.*.
 */
export async function chatOpencode(prompt: string, opts: ChatOpencodeOptions = {}): Promise<string> {
  const clean = prompt.trim();
  if (!clean) {
    throw new Error("[cli] /agent needs a prompt — usage: /agent <name> <prompt>.");
  }
  const env = opts.env ?? process.env;
  const key = getOpencodeKey(env);
  const endpoint = opts.endpoint ?? resolveChatEndpoint(env);
  const timeoutMs = opts.timeoutMs ?? OPENCODE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    model: opts.model ?? OPENCODE_DEFAULT_MODEL,
    state: clean,
    questions: {
      reply: {
        type: "choice",
        instructions: "Answer the user request from state.",
        criteria: { answer: "best answer", clarify: "needs clarification" },
      },
    },
  });

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const rawBody = scrubCause(await readBodyText(res));
        const failure = new Error(
          `[cli] opencode request failed status=${res.status} cause=${rawBody || "no body"}`,
        );
        const retriable = res.status === 429 || res.status >= 500;
        if (retriable && attempt === 0) {
          lastError = failure;
          continue;
        }
        throw failure;
      }
      const rawText = await readBodyText(res);
      let payload: unknown = rawText;
      try {
        payload = rawText ? (JSON.parse(rawText) as unknown) : "";
      } catch {
        payload = rawText;
      }
      const reply = extractReplyText(payload, rawText).trim();
      if (!reply) {
        throw new Error("[cli] opencode returned an empty reply (shape mismatch).");
      }
      return scrubOpencodeText(reply);
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      const aborted =
        (err instanceof Error && err.name === "AbortError") || /aborted|timeout/i.test(message);
      if (aborted) {
        throw new Error(`[cli] opencode request timed out after ${timeoutMs}ms cause=${scrubCause(message)}`);
      }
      const retriableNetwork =
        err instanceof TypeError || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message);
      if (retriableNetwork && attempt === 0) {
        lastError = err;
        continue;
      }
      if (err instanceof Error && /opencode request failed|empty reply/i.test(err.message)) {
        throw err;
      }
      lastError = err;
      if (attempt === 0) continue;
      throw new Error(`[cli] opencode request failed cause=${scrubCause(message)}`);
    }
  }
  const tail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`[cli] opencode request failed cause=${scrubCause(tail)}`);
}
