// agents/opencode/text — scrub + payload extract + failure mapping (no fetch).
import {
  OPENCODE_CAUSE_MAX,
  OPENCODE_CAUSE_PREVIEW,
  OPENCODE_CLOUD_MODEL,
  OPENCODE_CLOUD_URL,
  OPENCODE_SDK_VERSION,
} from "./constants.js";
import { formatKeySource, type OpencodeKeyInfo } from "./auth.js";

/** Scrub live secrets (Bearer, basic-auth URLs) → [redacted]. */
export function scrubOpencodeText(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s"']+/g, "$1[redacted]")
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@]+:)[^@\s/]+"?@/g, "$1[redacted]@")
    .replace(/:\/\/([^/\s:]+):([^@\s/]+)@/g, "://$1:[redacted]@");
}

export function scrubCause(text: string): string {
  return scrubOpencodeText(text).slice(0, OPENCODE_CAUSE_MAX);
}

export function extractLocalPartsText(payload: unknown): string {
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
export function extractCloudText(payload: unknown, fallbackText: string): string {
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
export function isPlaceholderReply(text: string): boolean {
  const lowered = text.trim().toLowerCase();
  return lowered === "answer" || lowered === "reply";
}

/** 400 hint class: invalid-key (401-like) vs service (endpoint/model). */
export function classify400Cause(cause: string): "invalid-key" | "service" | "generic" {
  const c = cause.toLowerCase();
  if (/invalid|unauthor|api[_-]?key|incorrect|forbidden|auth|credential|token/.test(c)) return "invalid-key";
  if (/model|endpoint|service|not.?found|does not exist|unsupported|param|schema|shape|template/.test(c)) return "service";
  return "generic";
}

export async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export function serveHint(base: string): string {
  return `(hint: opencode serve --port 4096, base ${base} — only when OPENCODE_USE_SERVE=1)`;
}

export function mapServeFailure(status: number, rawBody: string, base: string): Error {
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

export function mapCloudFailure(
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
