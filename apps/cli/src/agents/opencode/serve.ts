// agents/opencode/serve — OPTIONAL serve fallback (only when OPENCODE_USE_SERVE=1).
import { OPENCODE_CAUSE_MAX, OPENCODE_TIMEOUT_MS } from "./constants.js";
import { resolveChatModel, resolveLocalBaseUrl, resolveServeToken, type OpencodeModelRef } from "./config.js";
import {
  extractLocalPartsText,
  isPlaceholderReply,
  mapServeFailure,
  readBodyText,
  scrubCause,
  scrubOpencodeText,
  serveHint,
} from "./text.js";

export type ChatLocalOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Explicit model override for serve fallback (wins over OPENCODE_MODEL). */
  model?: OpencodeModelRef | null;
  /** Explicit cloud endpoint override (wins over OPENCODE_CLOUD_URL). */
  endpoint?: string;
};

/** In-memory local session id for the OPTIONAL serve fallback. */
let localSessionId = "";

/** Reset cached serve session id (tests only). */
export function resetLocalSessionForTests(): void {
  localSessionId = "";
}

export async function chatViaServe(prompt: string, opts: ChatLocalOptions): Promise<string> {
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
