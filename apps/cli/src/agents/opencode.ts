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

/**
 * Local `opencode serve` base URL — free text with the paid Go subscription
 * goes ONLY through the local serve. Auth: optional
 * `Authorization: Bearer <OPENCODE_TOKEN>` (serve password from the serve
 * log, same as backend OPENCODE_TOKEN env; '' = unauthenticated serve
 * without a password — header omitted). Serve still reads the Go key itself
 * from ~/.local/share/opencode/auth.json (written by /connect). Env
 * override: OPENCODE_URL || OPENCODE_SERVER_URL (dial 0.0.0.0 → 127.0.0.1
 * fallback is handled by the caller via URL). Cloud systemone (chatOpencode)
 * stays ONLY for choice classification.
 */
export const OPENCODE_LOCAL_URL = "http://127.0.0.1:4096";

/** Resolve local serve base (explicit env override only, never silent). */
export function resolveLocalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom =
    (env.OPENCODE_URL ?? "").trim() || (env.OPENCODE_SERVER_URL ?? "").trim();
  if (custom) return custom.replace(/\/+$/, "");
  return OPENCODE_LOCAL_URL;
}

/** In-memory local session id (per process, created lazily via POST /session). */
let localSessionId = "";

/** Reset cached local session id (tests only). */
export function resetLocalSessionForTests(): void {
  localSessionId = "";
}

export type ChatLocalOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function extractLocalPartsText(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  const parts = record["parts"];
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const entry of parts) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const text = (entry as Record<string, unknown>)["text"];
      if (typeof text === "string" && text.trim()) chunks.push(text.trim());
    }
  }
  if (chunks.length === 0) return "";
  return scrubOpencodeText(chunks.join("\n")).slice(0, OPENCODE_CAUSE_MAX);
}

/**
 * Free-text chat with the paid OpenCode Go subscription via local serve
 * (POST /session {title} → {id}, then POST /session/{id}/message
 * {parts:[{type:"text",text}]} → {parts:[...]}). Session id is cached in
 * process memory. Auth: optional `Authorization: Bearer <OPENCODE_TOKEN>`
 * (serve password from `opencode serve` log, '' = serve without password —
 * header omitted, as before). The token value is never logged (only its
 * presence could be traced as auth=yes|no). Throws scrubbed errors
 * (cause ≤2000 chars); serve down → hint `opencode serve --port 4096`.
 * No console.*.
 */
export async function chatLocal(prompt: string, opts: ChatLocalOptions = {}): Promise<string> {
  const clean = prompt.trim();
  if (!clean) {
    throw new Error("[cli] /agent needs a prompt — usage: /agent <name> <prompt>.");
  }
  const env = opts.env ?? process.env;
  const base = resolveLocalBaseUrl(env);
  const timeoutMs = opts.timeoutMs ?? OPENCODE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Serve password (printed by `opencode serve` on boot, same as backend
  // OPENCODE_TOKEN env): '' = serve without password → no header (as before).
  // Value is never logged — only its presence (auth=yes|no) may be traced.
  const serveToken = (env.OPENCODE_TOKEN ?? "").trim();

  const postJson = async (url: string, body: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(serveToken ? { Authorization: `Bearer ${serveToken}` } : {}),
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      const aborted =
        (err instanceof Error && err.name === "AbortError") || /aborted|timeout/i.test(message);
      if (aborted) {
        throw new Error(`[cli] opencode serve timed out after ${timeoutMs}ms cause=${scrubCause(message)}`);
      }
      throw new Error(
        `[cli] opencode serve unreachable at ${base} cause=${scrubCause(message)} (hint: opencode serve --port 4096)`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  if (!localSessionId) {
    const res = await postJson(
      `${base}/session`,
      JSON.stringify({ title: clean.slice(0, 80) }),
    );
    if (res.status === 503 || !res.ok) {
      const rawBody = scrubCause(await readBodyText(res));
      throw new Error(
        `[cli] opencode serve unreachable at ${base} status=${res.status} cause=${rawBody || "no body"} (hint: opencode serve --port 4096)`,
      );
    }
    const rawText = await readBodyText(res);
    let payload: unknown = rawText;
    try {
      payload = rawText ? (JSON.parse(rawText) as unknown) : "";
    } catch {
      payload = rawText;
    }
    const id =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)["id"]
        : null;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("[cli] opencode serve returned a session without id (shape mismatch).");
    }
    localSessionId = id.trim();
  }

  const res = await postJson(
    `${base}/session/${encodeURIComponent(localSessionId)}/message`,
    JSON.stringify({ parts: [{ type: "text", text: clean }] }),
  );
  if (res.status === 404) {
    // Stale cached session (serve restarted) — recreate once and retry.
    localSessionId = "";
    return chatLocal(clean, opts);
  }
  if (res.status === 503 || !res.ok) {
    const rawBody = scrubCause(await readBodyText(res));
    throw new Error(
      `[cli] opencode serve request failed status=${res.status} cause=${rawBody || "no body"} (hint: opencode serve --port 4096)`,
    );
  }
  const rawText = await readBodyText(res);
  let payload: unknown = rawText;
  try {
    payload = rawText ? (JSON.parse(rawText) as unknown) : "";
  } catch {
    payload = rawText;
  }
  const reply = extractLocalPartsText(payload).trim() || scrubOpencodeText(rawText).slice(0, OPENCODE_CAUSE_MAX).trim();
  if (!reply) {
    throw new Error("[cli] opencode serve returned an empty reply (shape mismatch).");
  }
  return scrubOpencodeText(reply);
}

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
  const pick = (value: unknown): string | null => {
    if (typeof value === "string" && value.trim())
      return scrubOpencodeText(value).slice(0, OPENCODE_CAUSE_MAX);
    return null;
  };
  if (typeof payload === "string" && payload.trim())
    return scrubOpencodeText(payload).slice(0, OPENCODE_CAUSE_MAX);
  if (Array.isArray(payload)) {
    const parts = payload
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    if (parts.length > 0)
      return scrubOpencodeText(parts.join("\n")).slice(0, OPENCODE_CAUSE_MAX);
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    // v2 systemone shape: {answers: {<name>: {choice, confidence, ...}}} —
    // priority: answers.reply.choice → answers.*.choice → answers.* (string).
    // Never return the key name (reply/answer) — only the .choice/string value.
    const answers = record["answers"];
    if (typeof answers === "string") {
      const hit = pick(answers);
      if (hit) return hit;
    }
    if (answers !== null && typeof answers === "object" && !Array.isArray(answers)) {
      const entries = answers as Record<string, unknown>;
      const replyEntry = entries["reply"];
      if (replyEntry !== null && typeof replyEntry === "object" && !Array.isArray(replyEntry)) {
        const hit = pick((replyEntry as Record<string, unknown>)["choice"]);
        if (hit) return hit;
      }
      for (const key of Object.keys(entries)) {
        if (key === "reply") continue;
        const entry = entries[key];
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
          const hit = pick((entry as Record<string, unknown>)["choice"]);
          if (hit) return hit;
        }
      }
      for (const key of Object.keys(entries)) {
        const hit = pick(entries[key]);
        if (hit) return hit;
      }
      if (replyEntry !== null && typeof replyEntry === "object" && !Array.isArray(replyEntry)) {
        const nested = replyEntry as Record<string, unknown>;
        for (const key of ["text", "message", "content"]) {
          const hit = pick(nested[key]);
          if (hit) return hit;
        }
      }
    }
    for (const key of ["text", "message", "content", "reply"]) {
      const hit = pick(record[key]);
      if (hit) return hit;
    }
    // OpenAI-style shapes: content[] / choices[] / delta → join text parts.
    // (noul is usually a number — only a string noul carries text.)
    const chunks: string[] = [];
    const pushText = (value: unknown): void => {
      if (typeof value === "string" && value.trim()) chunks.push(value.trim());
    };
    const pushEntry = (entry: unknown): void => {
      if (typeof entry === "string") {
        pushText(entry);
        return;
      }
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const item = entry as Record<string, unknown>;
        if (typeof item["text"] === "string") pushText(item["text"]);
        else if (typeof item["content"] === "string") pushText(item["content"]);
        else if (item["message"] !== null && typeof item["message"] === "object") {
          const message = item["message"] as Record<string, unknown>;
          if (typeof message["content"] === "string") pushText(message["content"]);
          else if (typeof message["text"] === "string") pushText(message["text"]);
        }
        if (item["delta"] !== null && typeof item["delta"] === "object" && !Array.isArray(item["delta"])) {
          const delta = item["delta"] as Record<string, unknown>;
          if (typeof delta["content"] === "string") pushText(delta["content"]);
          else if (typeof delta["text"] === "string") pushText(delta["text"]);
        }
      }
    };
    if (typeof record["noul"] === "string") pushText(record["noul"]);
    if (Array.isArray(record["content"])) record["content"].forEach(pushEntry);
    if (Array.isArray(record["choices"])) record["choices"].forEach(pushEntry);
    if (record["delta"] !== null && typeof record["delta"] === "object" && !Array.isArray(record["delta"])) {
      const delta = record["delta"] as Record<string, unknown>;
      if (typeof delta["content"] === "string") pushText(delta["content"]);
      else if (typeof delta["text"] === "string") pushText(delta["text"]);
    }
    if (chunks.length > 0)
      return scrubOpencodeText(chunks.join("\n")).slice(0, OPENCODE_CAUSE_MAX);
  }
  return scrubOpencodeText(fallbackText).slice(0, OPENCODE_CAUSE_MAX);
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
