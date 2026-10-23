// agents/opencode — direct cloud chat (no serve by default, no UI, no console.*).
//
// Decision (2026-10-23, documented in apps/cli/README § Chat/Env):
// - Canon + context7 (opencode docs) have NO proven direct cloud chat with
//   free text for the Go subscription:
//   * SDK docs (createOpencodeClient → session.create → session.prompt) need
//     a RUNNING server (baseUrl default http://localhost:4096) — that is the
//     old serve-only path (405/unreachable without serve).
//   * Cloud systemone (POST https://opencode.ai/inference/systemone/v1/systemone
//     {model:"jev-1.13-free", state, questions} + Bearer,
//     .opencode/tools/classify_build.ts) is choice-only (builder choice +
//     needs_tunnel noul) — it collapses to the literal "answer" when misused
//     for chat, so it is REJECTED for chat (stays only for classification).
//   * Billing/Zen usage (GET https://opencode.ai/zen/go/v1/usage, see
//     apps/backend/src/opencode-keys/opencode-billing.service.ts) is usage
//     only, not chat.
// - Documented inference endpoint (see https://opencode.ai/v2/docs/console/models):
//   base https://opencode.ai/inference + OpenAI-compatible
//   `/openai/v1/chat/completions` (DeepSeek via `@ai-sdk/openai-compatible`).
//   => default OPENCODE_CLOUD_URL="https://opencode.ai/inference/openai/v1/chat/completions".
//   If upstream answers 404/shape-mismatch we surface a scrubbed error
//   (never empty/answer).
// - Transport: cloud-first (Bearer from auth.json only, timeout 30s, 1 retry
//   on network/429/5xx, scrub Bearer/URL→[redacted], cause≤2000, fail-fast
//   missing key). No mandatory localhost:4096.
// - Serve is OPTIONAL fallback only, behind explicit
//   OPENCODE_USE_SERVE=1 (default off = cloud without serve). When enabled
//   and cloud fails, we try the local serve SDK-contract once
//   (POST /session → POST /session/{id}/message, pinned SDK 1.18.33).
// Key source (canonical):
// auth.json ONLY ($HOME/.local/share/opencode/auth.json, XDG_DATA_HOME
// override, JSON {opencode:{key}, opencode-go:{key}}). env is NEVER read
// for the key (OPENCODE_API_KEY/JEV_API_KEY ignored). Missing → fail-fast
// missing key in auth.json. Secrets never in messages/logs (only
// auth=yes|no may be traced, value never logged).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENCODE_TIMEOUT_MS = 30_000;
export const OPENCODE_CAUSE_MAX = 2000;
/** Preview slice shown in errorBox (full cause ≤2000 stays in message). */
export const OPENCODE_CAUSE_PREVIEW = 500;

/** Pinned SDK version the OPTIONAL serve fallback mirrors (same as backend). */
export const OPENCODE_SDK_VERSION = "1.18.33";

/**
 * Direct cloud chat endpoint (documented inference endpoint, see header).
 * Explicit override only via OPENCODE_CLOUD_URL (never silent, never from
 * auth.json). Default has no trailing slash.
 */
export const OPENCODE_CLOUD_URL = "https://opencode.ai/inference/openai/v1/chat/completions";

/** Default cloud model (DeepSeek V4.1 Flash; override via OPENCODE_MODEL). */
export const OPENCODE_CLOUD_MODEL = "deepseek-v4.1-flash";

/** Local serve base for the OPTIONAL fallback (never required by default). */
export const OPENCODE_LOCAL_URL = "http://127.0.0.1:4096";

/** Resolve cloud chat URL (explicit OPENCODE_CLOUD_URL override only). */
export function resolveCloudUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom = (env.OPENCODE_CLOUD_URL ?? "").trim();
  return (custom || OPENCODE_CLOUD_URL).replace(/\/+$/, "");
}

/** Resolve cloud model id (OPENCODE_MODEL wins, then OPENCODE_CLOUD_MODEL). */
export function resolveCloudModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.OPENCODE_MODEL ?? "").trim() || (env.OPENCODE_CLOUD_MODEL ?? "").trim();
  return raw || OPENCODE_CLOUD_MODEL;
}

/** True when the optional serve fallback is explicitly enabled. */
export function isServeFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OPENCODE_USE_SERVE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Resolve local serve base (explicit env override only, never silent). */
export function resolveLocalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom =
    (env.OPENCODE_URL ?? "").trim() || (env.OPENCODE_SERVER_URL ?? "").trim();
  const base = (custom || OPENCODE_LOCAL_URL).replace(/\/+$/, "");
  // Mirror OpencodeService.dialUrl(): 0.0.0.0 / :: are undialable —
  // probe 127.0.0.1 instead. The configured value is kept verbatim
  // everywhere except this outbound dial remap.
  try {
    const parsed = new URL(base);
    if (parsed.hostname === "0.0.0.0" || parsed.hostname === "::") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    return base;
  }
  return base;
}

/**
 * Serve password for the OPTIONAL fallback (`opencode serve` prints it on
 * boot, same secret as backend OPENCODE_TOKEN env; alias
 * OPENCODE_SERVER_PASSWORD). '' = serve without password → header omitted.
 * Value is never logged.
 */
export function resolveServeToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENCODE_TOKEN ?? "").trim() || (env.OPENCODE_SERVER_PASSWORD ?? "").trim();
}

/** Chat model reference ({providerID, modelID} as serve upstream expects). */
export type OpencodeModelRef = {
  providerID: string;
  modelID: string;
};

/**
 * Parse OPENCODE_MODEL="providerID/modelID" for the serve fallback
 * (surrounding whitespace and extra slashes trimmed;
 * "provider/model/extra" keeps the tail as modelID). Returns null when
 * unset or malformed (caller omits `model`). Cloud uses the raw string
 * as-is (OpenAI-compatible model id), so this parses only the fallback.
 */
export function parseModelRef(raw: string): OpencodeModelRef | null {
  const clean = raw.trim().replace(/^\/+|\/+$/g, "");
  const slash = clean.indexOf("/");
  if (slash <= 0 || slash >= clean.length - 1) return null;
  const providerID = clean.slice(0, slash).trim();
  const modelID = clean.slice(slash + 1).trim().replace(/^\/+|\/+$/g, "");
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

/**
 * Resolve the serve-fallback model: explicit OPENCODE_MODEL only;
 * undefined = serve default (no `model` sent). jev ("jev-1.13-free") is
 * rejected on purpose: SystemOne is choice-only, not a chat provider.
 */
export function resolveChatModel(env: NodeJS.ProcessEnv = process.env): OpencodeModelRef | undefined {
  const raw = (env.OPENCODE_MODEL ?? "").trim();
  if (!raw) return undefined;
  const ref = parseModelRef(raw);
  if (!ref) return undefined;
  if (ref.providerID.toLowerCase() === "jev" || ref.modelID === "jev-1.13-free") return undefined;
  return ref;
}

/** In-memory local session id for the OPTIONAL serve fallback. */
let localSessionId = "";

/** Reset cached serve session id (tests only). */
export function resetLocalSessionForTests(): void {
  localSessionId = "";
}

export type ChatLocalOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Explicit model override for serve fallback (wins over OPENCODE_MODEL). */
  model?: OpencodeModelRef | null;
  /** Explicit cloud endpoint override (wins over OPENCODE_CLOUD_URL). */
  endpoint?: string;
};

export type ChatCloudOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Explicit cloud endpoint override (wins over OPENCODE_CLOUD_URL). */
  endpoint?: string;
  /** Explicit cloud model id override (wins over resolved model). */
  model?: string;
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

/** Extract free text from an OpenAI-compatible chat payload (defensive). */
function extractCloudText(payload: unknown, fallbackText: string): string {
  const pick = (value: unknown): string | null => {
    if (typeof value === "string" && value.trim()) {
      return scrubOpencodeText(value).slice(0, OPENCODE_CAUSE_MAX);
    }
    return null;
  };
  if (typeof payload === "string") return pick(payload) ?? "";
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const choices = record["choices"];
    if (Array.isArray(choices)) {
      const chunks: string[] = [];
      for (const entry of choices) {
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
          const item = entry as Record<string, unknown>;
          const message = item["message"];
          if (message !== null && typeof message === "object" && !Array.isArray(message)) {
            const content = (message as Record<string, unknown>)["content"];
            if (typeof content === "string" && content.trim()) {
              chunks.push(content.trim());
              continue;
            }
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block !== null && typeof block === "object" && !Array.isArray(block)) {
                  const text = (block as Record<string, unknown>)["text"];
                  if (typeof text === "string" && text.trim()) chunks.push(text.trim());
                }
              }
              if (chunks.length > 0) continue;
            }
          }
          if (typeof item["text"] === "string" && (item["text"] as string).trim()) {
            chunks.push((item["text"] as string).trim());
            continue;
          }
          const delta = item["delta"];
          if (delta !== null && typeof delta === "object" && !Array.isArray(delta)) {
            const d = delta as Record<string, unknown>;
            if (typeof d["content"] === "string" && (d["content"] as string).trim()) {
              chunks.push((d["content"] as string).trim());
            }
          }
        } else if (typeof entry === "string" && entry.trim()) {
          chunks.push(entry.trim());
        }
      }
      if (chunks.length > 0) {
        return scrubOpencodeText(chunks.join("\n")).slice(0, OPENCODE_CAUSE_MAX);
      }
    }
    for (const key of ["content", "text", "message", "reply"]) {
      const hit = pick(record[key]);
      if (hit) return hit;
    }
    const partsText = extractLocalPartsText(payload);
    if (partsText.trim()) return partsText;
  }
  if (Array.isArray(payload)) {
    const parts = payload
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    if (parts.length > 0) return scrubOpencodeText(parts.join("\n")).slice(0, OPENCODE_CAUSE_MAX);
  }
  return scrubOpencodeText(fallbackText).slice(0, OPENCODE_CAUSE_MAX).trim();
}

/** Single-word "answer"/"reply" is a systemone/classify leak, never a chat reply. */
function isPlaceholderReply(text: string): boolean {
  const lowered = text.trim().toLowerCase();
  return lowered === "answer" || lowered === "reply";
}

export const MISSING_KEY_MESSAGE =
  "[cli] missing opencode key in auth.json → вставь через /connect в TUI " +
  "(см. apps/cli/.env.example).";

/** Auth file path ($HOME/.local/share/opencode/auth.json, XDG_DATA_HOME override). */
export function opencodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.XDG_DATA_HOME ?? "").trim();
  const dataDir = override || path.join(os.homedir(), ".local", "share");
  return path.join(dataDir, "opencode", "auth.json");
}

/**
 * Key file diagnostics WITHOUT the value (safe for errorBox/logs).
 * Probes the same-uid read before any fetch: stat perms/owner + trial
 * read (only len, never the key). EACCES/parse → exists=false + reason.
 */
export type OpencodeKeyInfo = {
  path: string;
  exists: boolean;
  /** Key length only (never the value). 0 when missing/unreadable. */
  keyLen: number;
  /** Octal perms like "600" (empty when unknown). */
  modeOct: string;
  /** File owner uid (-1 when unknown). */
  uid: number;
  /** True when file uid matches current process uid. */
  sameUid: boolean;
  reason?: string;
};

export function getOpencodeKeyInfo(env: NodeJS.ProcessEnv = process.env): OpencodeKeyInfo {
  const authPath = opencodeAuthPath(env);
  const base: OpencodeKeyInfo = {
    path: authPath,
    exists: false,
    keyLen: 0,
    modeOct: "",
    uid: -1,
    sameUid: false,
  };
  let stat: { mode: number; uid: number } | null = null;
  try {
    const st = fs.statSync(authPath);
    stat = { mode: st.mode, uid: typeof st.uid === "number" ? st.uid : -1 };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    return { ...base, reason: code === "EACCES" ? `EACCES uid=${process.getuid?.() ?? -1}` : code };
  }
  const modeOct = stat ? (stat.mode & 0o777).toString(8) : "";
  const uid = stat?.uid ?? -1;
  const ownUid = typeof process.getuid === "function" ? process.getuid() : -1;
  const sameUid = ownUid === -1 || uid === -1 ? true : uid === ownUid;
  let raw = "";
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    return { ...base, modeOct, uid, sameUid, reason: code };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ...base, modeOct, uid, sameUid, reason: "parse-error" };
  }
  const record = (parsed ?? {}) as Record<string, { key?: unknown } | undefined>;
  const candidate = record?.["opencode-go"]?.key ?? record?.opencode?.key ?? "";
  if (typeof candidate === "string" && candidate.trim()) {
    return { path: authPath, exists: true, keyLen: candidate.trim().length, modeOct, uid, sameUid };
  }
  return { ...base, modeOct, uid, sameUid, reason: "empty-key" };
}

/** One-line key_source for errorBox (no value, only len + file attrs). */
export function formatKeySource(info: OpencodeKeyInfo): string {
  const perms = info.modeOct || "?";
  const uid = info.uid === -1 ? "?" : String(info.uid);
  return `key_source=auth.json path=${info.path} perms=${perms} uid=${uid} uid_match=${info.sameUid ? "yes" : "no"} key_len=${info.keyLen}`;
}

/** 400 hint class: invalid-key (401-like) vs service (endpoint/model). */
export function classify400Cause(cause: string): "invalid-key" | "service" | "generic" {
  const c = cause.toLowerCase();
  if (/invalid|unauthor|api[_-]?key|incorrect|forbidden|auth|credential|token/.test(c)) return "invalid-key";
  if (/model|endpoint|service|not.?found|does not exist|unsupported|param|schema|shape|template/.test(c)) return "service";
  return "generic";
}

/**
 * Resolve the cloud key or throw fail-fast (never returns empty, never logs
 * the value). Chat REQUIRES this key — the Go subscription is billed by key
 * (same key as /connect, auth.json ONLY — env key vars are never read).
 * env is used ONLY for XDG_DATA_HOME path override, never for the key value.
 * Signature getOpencodeKey(env?) kept for CLI compat; key vars ignored.
 * Probes same-uid read first (stat perms/owner + trial read, len only):
 * EACCES/parse → missing with path.
 */
export function getOpencodeKey(env: NodeJS.ProcessEnv = process.env): string {
  const authPath = opencodeAuthPath(env);
  try {
    fs.statSync(authPath);
  } catch {
    throw new Error(`${MISSING_KEY_MESSAGE} path=${authPath}`);
  }
  let raw = "";
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "read-error";
    throw new Error(`${MISSING_KEY_MESSAGE} path=${authPath} reason=${code}`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${MISSING_KEY_MESSAGE} path=${authPath} reason=parse-error`);
  }
  const record = (parsed ?? {}) as Record<string, { key?: unknown } | undefined>;
  const candidate = record?.["opencode-go"]?.key ?? record?.opencode?.key ?? "";
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  throw new Error(`${MISSING_KEY_MESSAGE} path=${authPath} reason=empty-key`);
}

/** True when a cloud key resolves (auth.json only), false otherwise (no throw). */
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

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function serveHint(base: string): string {
  return `(hint: opencode serve --port 4096, base ${base} — only when OPENCODE_USE_SERVE=1)`;
}

function mapServeFailure(status: number, rawBody: string, base: string): Error {
  const cause = scrubCause(rawBody) || "no body";
  if (status === 401) {
    return new Error(
      `[cli] opencode serve rejected the password status=401 cause=${cause} ` +
        `(hint: export OPENCODE_TOKEN=<пароль из лога opencode serve> либо запусти serve без пароля)`,
    );
  }
  if (status === 404) {
    return new Error(
      `[cli] opencode serve session expired status=404 cause=${cause} ${serveHint(base)}`,
    );
  }
  if (status === 405) {
    return new Error(
      `[cli] opencode serve rejected the request status=405 cause=${cause} ` +
        `(hint: обнови opencode/serve до ${OPENCODE_SDK_VERSION}, проверь OPENCODE_URL=${base})`,
    );
  }
  if (status === 429) {
    return new Error(
      `[cli] opencode serve rate-limited status=429 cause=${cause} (retry later)`,
    );
  }
  return new Error(`[cli] opencode serve request failed status=${status} cause=${cause} ${serveHint(base)}`);
}

function mapCloudFailure(
  status: number,
  rawBody: string,
  url: string,
  diag?: { model?: string; keyInfo?: OpencodeKeyInfo },
): Error {
  const fullCause = scrubCause(rawBody) || "no body";
  // errorBox wraps (never …-cuts), so keep the full scrubbed cause there;
  // the one-line status keeps the first PREVIEW chars for grep-ability.
  const cause = fullCause;
  const preview = fullCause.slice(0, OPENCODE_CAUSE_PREVIEW);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "cloud";
    }
  })();
  const model = (diag?.model ?? "").trim() || OPENCODE_CLOUD_MODEL;
  const keyInfo = diag?.keyInfo;
  const keyBits = keyInfo
    ? ` ${formatKeySource(keyInfo)}`
    : "";
  // Body-shape is fixed (OpenAI-compatible): {model, messages:[{role,content}]}.
  const suffix = ` endpoint=${url} model=${model}${keyBits} body-shape={model,messages:1} cause=${cause}`;
  if (status === 400) {
    const kind = classify400Cause(fullCause);
    const hint =
      kind === "invalid-key"
        ? "обновить ключ через /connect в TUI (ключ отклонён, см. key_len/uid выше)"
        : kind === "service"
          ? `проверь OPENCODE_CLOUD_URL/model (endpoint/model mismatch, host ${host})`
          : `проверь OPENCODE_CLOUD_URL/model и тело (первые ${OPENCODE_CAUSE_PREVIEW} симв cause выше, host ${host})`;
    return new Error(
      `[cli] opencode cloud bad request status=400 preview=${preview} (hint: ${hint})${suffix}`,
    );
  }
  if (status === 401 || status === 403) {
    return new Error(
      `[cli] opencode cloud rejected the key status=${status} cause=${cause} ` +
        `(hint: обнови ключ через /connect в TUI, host ${host})${keyBits} endpoint=${url} model=${model}`,
    );
  }
  if (status === 404) {
    return new Error(
      `[cli] opencode cloud endpoint not found status=404 cause=${cause} ` +
        `(endpoint: ${OPENCODE_CLOUD_URL} is the documented inference chat endpoint — ` +
        `check OPENCODE_CLOUD_URL, see README § Chat) endpoint=${url} model=${model}${keyBits}`,
    );
  }
  if (status === 429) {
    return new Error(
      `[cli] opencode cloud rate-limited status=429 cause=${cause} (retry later) endpoint=${url} model=${model}${keyBits}`,
    );
  }
  return new Error(`[cli] opencode cloud request failed status=${status} cause=${cause} host=${host} endpoint=${url} model=${model}${keyBits}`);
}

/**
 * Direct cloud chat with the paid Go subscription via the documented
 * inference endpoint (OpenAI-compatible POST {model, messages} → choices text).
 * Bearer from auth.json only (fail-fast missing), timeout 30s, 1 retry on
 * network/429/5xx. Throws scrubbed errors (cause ≤2000); reply always text,
 * never empty and never the "answer"/"reply" placeholder. No console.*.
 * No localhost required — serve is NOT called here (see chatLocal for the
 * optional fallback).
 */
export async function chatCloud(prompt: string, opts: ChatCloudOptions = {}): Promise<string> {
  const clean = prompt.trim();
  if (!clean) {
    throw new Error("[cli] /agent needs a prompt — usage: /agent <name> <prompt>.");
  }
  const env = opts.env ?? process.env;
  const key = getOpencodeKey(env);
  const keyInfo = getOpencodeKeyInfo(env);
  const url = (opts.endpoint ?? resolveCloudUrl(env)).replace(/\/+$/, "");
  const model = (opts.model ?? resolveCloudModel(env)).trim() || OPENCODE_CLOUD_MODEL;
  const timeoutMs = opts.timeoutMs ?? OPENCODE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({ model, messages: [{ role: "user", content: clean }] });

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const failure = mapCloudFailure(res.status, await readBodyText(res), url, { model, keyInfo });
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
      const reply = extractCloudText(payload, rawText).trim();
      if (!reply || isPlaceholderReply(reply)) {
        throw new Error("[cli] opencode cloud returned an empty reply (shape mismatch).");
      }
      return scrubOpencodeText(reply);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && /empty reply|needs a prompt|rejected the key|endpoint not found/i.test(err.message)) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const aborted =
        (err instanceof Error && err.name === "AbortError") || /aborted|timeout/i.test(message);
      if (aborted) {
        throw new Error(`[cli] opencode cloud timed out after ${timeoutMs}ms cause=${scrubCause(message)}`);
      }
      const retriableNetwork =
        err instanceof TypeError || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message);
      const tagged = err instanceof Error && /cloud request failed|rate-limited/i.test(err.message);
      if ((retriableNetwork || tagged) && attempt === 0) {
        lastError = err;
        continue;
      }
      if (err instanceof Error && /opencode cloud/i.test(err.message)) throw err;
      lastError = err;
      if (attempt === 0) continue;
      throw new Error(`[cli] opencode cloud request failed cause=${scrubCause(message)}`);
    }
  }
  const tail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`[cli] opencode cloud request failed cause=${scrubCause(tail)}`);
}

async function chatViaServe(prompt: string, opts: ChatLocalOptions): Promise<string> {
  const clean = prompt.trim();
  const env = opts.env ?? process.env;
  const base = resolveLocalBaseUrl(env);
  const timeoutMs = opts.timeoutMs ?? OPENCODE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const serveToken = resolveServeToken(env);
  const model = opts.model !== undefined ? opts.model ?? undefined : resolveChatModel(env);

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
        `[cli] opencode serve unreachable at ${base} cause=${scrubCause(message)} ${serveHint(base)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const createSession = async (): Promise<string> => {
    const res = await postJson(`${base}/session`, JSON.stringify({ title: clean.slice(0, 80) }));
    if (!res.ok) throw mapServeFailure(res.status, await readBodyText(res), base);
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
    return id.trim();
  };

  const promptSession = async (sessionId: string): Promise<Response> => {
    const body: Record<string, unknown> = { parts: [{ type: "text", text: clean }] };
    if (model) body.model = { providerID: model.providerID, modelID: model.modelID };
    return postJson(`${base}/session/${encodeURIComponent(sessionId)}/message`, JSON.stringify(body));
  };

  const readReply = async (res: Response): Promise<string> => {
    const rawText = await readBodyText(res);
    let payload: unknown = rawText;
    try {
      payload = rawText ? (JSON.parse(rawText) as unknown) : "";
    } catch {
      payload = rawText;
    }
    const reply = (
      extractLocalPartsText(payload).trim() ||
      scrubOpencodeText(rawText).slice(0, OPENCODE_CAUSE_MAX).trim()
    );
    if (!reply || isPlaceholderReply(reply)) {
      throw new Error("[cli] opencode serve returned an empty reply (shape mismatch).");
    }
    return scrubOpencodeText(reply);
  };

  const attempt = async (recreated: boolean): Promise<string> => {
    if (!localSessionId) localSessionId = await createSession();
    const res = await promptSession(localSessionId);
    if (res.status === 404 && !recreated) {
      localSessionId = "";
      return attempt(true);
    }
    if (!res.ok) throw mapServeFailure(res.status, await readBodyText(res), base);
    return readReply(res);
  };

  let lastError: unknown = null;
  for (let round = 0; round < 2; round += 1) {
    try {
      return await attempt(round === 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/empty reply|without id|needs a prompt/i.test(message)) throw err;
      const retriable =
        /unreachable|timed out|status=429|status=503|status=5\d\d|rate-limited/i.test(message);
      lastError = err;
      if (retriable && round === 0) continue;
      throw err;
    }
  }
  const tail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`[cli] opencode serve request failed cause=${scrubCause(tail)} ${serveHint(base)}`);
}

/**
 * Free-text chat (cloud-first, same signature as before so cli.ts is
 * untouched apart from hints). Default: direct cloud via chatCloud (needs
 * auth.json key only, no localhost, env key vars ignored). Serve is tried
 * ONLY when explicit OPENCODE_USE_SERVE=1 and cloud failed. Reply always
 * text, never empty and never "answer"/"reply". No console.*.
 */
export async function chatLocal(prompt: string, opts: ChatLocalOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  try {
    return await chatCloud(prompt, {
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      env,
      endpoint: opts.endpoint,
      model: typeof env.OPENCODE_MODEL === "string" && !env.OPENCODE_MODEL.includes("/") ? env.OPENCODE_MODEL.trim() || undefined : undefined,
    });
  } catch (cloudErr) {
    if (!isServeFallbackEnabled(env)) throw cloudErr;
    resetLocalSessionForTests();
    return chatViaServe(prompt, opts);
  }
}
