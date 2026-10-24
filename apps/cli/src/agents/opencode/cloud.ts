// agents/opencode/cloud — direct cloud chat (no serve, no localhost required).
import { OPENCODE_CLOUD_MODEL, OPENCODE_TIMEOUT_MS } from "./constants.js";
import { resolveCloudModel, resolveCloudUrl } from "./config.js";
import { getOpencodeKey, getOpencodeKeyInfo } from "./auth.js";
import {
  extractCloudText,
  isPlaceholderReply,
  mapCloudFailure,
  readBodyText,
  scrubCause,
  scrubOpencodeText,
} from "./text.js";

export type ChatCloudOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Explicit cloud endpoint override (wins over OPENCODE_CLOUD_URL). */
  endpoint?: string;
  /** Explicit cloud model id override (wins over resolved model). */
  model?: string;
};

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
