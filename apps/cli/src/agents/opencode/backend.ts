// OpenCode-compatible session API through the Rush Code backend.
import { OPENCODE_CAUSE_MAX, OPENCODE_TIMEOUT_MS } from "./constants.js";
import { resolveChatModel, type OpencodeModelRef } from "./config.js";
import { backendApiUrl, resolveBackendUrl } from "../../core/backend.js";
import {
  extractLocalPartsText,
  isPlaceholderReply,
  readBodyText,
  scrubCause,
  scrubOpencodeText,
} from "./text.js";

export type ChatBackendOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  model?: OpencodeModelRef | null;
};

function mapBackendFailure(status: number, body: string): Error {
  const cause = scrubCause(body) || "no body";
  return new Error(`[cli] backend request failed status=${status} cause=${cause}`);
}

let sessionId = "";
let sessionBase = "";

export function resetBackendSessionForTests(): void {
  sessionId = "";
  sessionBase = "";
}

export async function chatViaBackend(prompt: string, opts: ChatBackendOptions = {}): Promise<string> {
  const clean = prompt.trim();
  if (!clean) throw new Error("[cli] /agent needs a prompt — usage: /agent <name> <prompt>.");

  const env = opts.env ?? process.env;
  const base = resolveBackendUrl(env);
  const apiUrl = backendApiUrl(base);
  const timeoutMs = opts.timeoutMs ?? OPENCODE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model !== undefined ? opts.model ?? undefined : resolveChatModel(env);

  const postJson = async (url: string, body: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted =
        (err instanceof Error && err.name === "AbortError") || /aborted|timeout/i.test(message);
      if (aborted) {
        throw new Error(`[cli] backend request timed out after ${timeoutMs}ms cause=${scrubCause(message)}`);
      }
      throw new Error(`[cli] backend unreachable cause=${scrubCause(message)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const createSession = async (): Promise<string> => {
    const response = await postJson(`${apiUrl}/session`, JSON.stringify({ title: clean.slice(0, 80) }));
    if (!response.ok) throw mapBackendFailure(response.status, await readBodyText(response));
    const raw = await readBodyText(response);
    let payload: unknown = raw;
    try {
      payload = raw ? (JSON.parse(raw) as unknown) : "";
    } catch {
      payload = raw;
    }
    const id =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).id
        : null;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("[cli] backend returned a session without id (shape mismatch).");
    }
    return id.trim();
  };

  const postPrompt = async (id: string): Promise<Response> => {
    const body: Record<string, unknown> = { parts: [{ type: "text", text: clean }] };
    if (model) body.model = { providerID: model.providerID, modelID: model.modelID };
    return postJson(`${apiUrl}/session/${encodeURIComponent(id)}/message`, JSON.stringify(body));
  };

  const readReply = async (response: Response): Promise<string> => {
    const raw = await readBodyText(response);
    let payload: unknown = raw;
    try {
      payload = raw ? (JSON.parse(raw) as unknown) : "";
    } catch {
      payload = raw;
    }
    const reply = extractLocalPartsText(payload).trim() || scrubOpencodeText(raw).slice(0, OPENCODE_CAUSE_MAX).trim();
    if (!reply || isPlaceholderReply(reply)) {
      throw new Error("[cli] backend returned an empty reply (shape mismatch).");
    }
    return scrubOpencodeText(reply);
  };

  const attempt = async (recreated: boolean): Promise<string> => {
    if (sessionBase !== base) {
      sessionId = "";
      sessionBase = base;
    }
    if (!sessionId) sessionId = await createSession();
    const response = await postPrompt(sessionId);
    if (response.status === 404 && !recreated) {
      sessionId = "";
      return attempt(true);
    }
    if (!response.ok) throw mapBackendFailure(response.status, await readBodyText(response));
    return readReply(response);
  };

  let lastError: unknown;
  for (let round = 0; round < 2; round += 1) {
    try {
      return await attempt(round === 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/empty reply|without id|needs a prompt/i.test(message)) throw err;
      const retriable = /unreachable|timed out|status=429|status=503|status=5\d\d|rate-limited/i.test(message);
      lastError = err;
      if (retriable && round === 0) continue;
      throw err;
    }

  }
  const tail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`[cli] backend request failed cause=${scrubCause(tail)}`);
}
