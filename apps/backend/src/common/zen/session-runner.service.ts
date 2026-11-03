import { HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AppLogger } from '../logger';
import { ExternalClient } from '../external/external-client';
import { ExternalServiceError, fromStatus, fromUnknown } from '../external/external-error';
import { CryptoService } from '../crypto/crypto.service';
import { OpencodeKeysService } from '../keys/opencode-keys.service';

/**
 * Direct cloud chat endpoint (module constant, same precedent as
 * BillingService.BILLING_URL: no env override — the endpoint is fixed).
 *
 * Provenance: apps/cli/src/agents/opencode/constants.ts OPENCODE_CLOUD_URL
 * (documented inference endpoint, see apps/cli/README.md §Chat) —
 * OpenAI-compatible POST {model, messages:[{role:'user', content}]} →
 * choices text, Bearer, timeout 30s (apps/cli/src/agents/opencode/cloud.ts).
 */
export const ZEN_CHAT_URL = 'https://opencode.ai/inference/openai/v1/chat/completions';

/**
 * Default cloud model, plain id (provenance: apps/cli constants
 * OPENCODE_CLOUD_MODEL='deepseek-v4.1-flash'; CLI cloud sends the plain id
 * via resolveCloudModel). The endpoint requires `model` in every body.
 */
export const CLOUD_DEFAULT_MODEL = 'deepseek-v4.1-flash';

export type ZenChatOptions = {
  /**
   * Plain upstream Model ID (CLOUD_DEFAULT_MODEL when omitted; a legacy
   * `providerID/modelID` ref is normalized to the part after the last '/').
   */
  model?: string;
  /** Traced through every attempt log line (never logged as a secret). */
  correlationId?: string;
  /**
   * Progressive sink: the stream:true attempt calls it per SSE delta chunk
   * (the harness tails message.part.delta frames through it while the answer
   * is still arriving). Best-effort — a throwing sink never fails the answer.
   */
  onDelta?: (chunk: string) => void;
};

/** Per-attempt budget for chat (the 10s default kills slow answers mid-stream). */
const CHAT_TIMEOUT_MS = 90000;

/**
 * Local model guard (quota saver — same 400 envelope, the contract is
 * untouched): these ids can only fail the same way upstream, so reject before
 * any fetch instead of burning key quota on retries.
 *
 * - DEPRECATED: docs deprecated table + CLI README (removed model aliases).
 * - INCOMPATIBLE: docs endpoints table — families that chat/completions does
 *   not serve (claude-/gpt-/gemini-/grok-/google-/anthropic- prefixes, the
 *   jev-1.13 image ids).
 * - FREE: docs free-models list (+ any *-free id) — free-tier chat requires
 *   the OpenCode client; this runner calls as an other client with a Go key,
 *   so upstream answers 400 (observed: free → 400, paid deepseek → answer).
 */
const DEPRECATED_CHAT_MODELS: ReadonlySet<string> = new Set([
  'qwen-3-coder-480b',
  'deepseek-v4-flash',
  'gpt-5.2-codex',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5-codex',
  'claude-opus-4.1',
  'claude-sonnet-4',
  'claude-haiku-3.5',
  'gemini-3-pro',
  'minimax-m2.5',
  'minimax-m2.1',
  'glm-5',
  'glm-4.7',
  'glm-4.6',
  'kimi-k2.5',
  'kimi-k2-thinking',
  'kimi-k2',
]);

const INCOMPATIBLE_CHAT_PREFIXES: ReadonlyArray<string> = [
  'claude-',
  'gpt-',
  'gemini-',
  'grok-',
  'google-',
  'anthropic-',
];

const INCOMPATIBLE_CHAT_EXACT: ReadonlySet<string> = new Set(['jev-1.13', 'jev-1.13-free']);

const KNOWN_FREE_CHAT_MODELS: ReadonlySet<string> = new Set([
  'big-pickle',
  'pulse-alpha-free',
  'glm-5.3-flash-free',
  'deepseek-v4.1-flash-free',
  'beam-free',
  'flint-40b-free',
  'mimo-v2.6-flash-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'jev-1.13-free',
]);

/** Guard reason for a normalized model id, null when the id may go upstream. */
function chatModelGuard(model: string): 'deprecated' | 'incompatible' | 'free' | null {
  const id = model.toLowerCase();
  if (DEPRECATED_CHAT_MODELS.has(id)) return 'deprecated';
  if (INCOMPATIBLE_CHAT_EXACT.has(id)) return 'incompatible';
  for (const prefix of INCOMPATIBLE_CHAT_PREFIXES) {
    if (id.startsWith(prefix)) return 'incompatible';
  }
  if (id.endsWith('-free') || KNOWN_FREE_CHAT_MODELS.has(id)) return 'free';
  return null;
}

/**
 * One OpenAI SSE delta chunk (choices[0].delta.content — the same branch the
 * CLI extractCloudText reads in apps/cli/src/agents/opencode/text.ts).
 */
function extractStreamDelta(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== 'object' || delta === null) return null;
  const content = (delta as { content?: unknown }).content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/** Narrowed OpenAI-compatible chat payload members (only what the projection reads). */
type ZenChatResponse = {
  choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  text?: unknown;
  content?: unknown;
  answer?: unknown;
};

function extractText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const rec = payload as ZenChatResponse;
  const choices = rec.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    const content = first?.message?.content;
    if (typeof content === 'string' && content.length > 0) return content;
    if (typeof first?.text === 'string' && first.text.length > 0) return first.text;
  }
  for (const key of ['text', 'content', 'answer'] as const) {
    const value = rec[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * SCOPE: Common — reusable model transport, no organization/project knowledge.
 *
 * SessionRunnerService — direct per-user model calls (the harness-owned runner
 * transport; the `opencode serve` stand is no longer required on this path).
 *
 * - Key: the caller's row from OpencodeKeysService, decrypted in memory via
 *   CryptoService (existing keys-rotation: dual-read + lazy re-encrypt under the
 *   active KEK — same lines as BillingService.getUsage; billing is untouched).
 *   Missing row → 404 `opencode_key_missing` (same code the billing surface
 *   answers, so the key-setup UX stays one flow). The plaintext lives only in
 *   this request (upstream Bearer) and is never logged.
 * - Transport: ExternalClient (REQUEST_TIMEOUT_MS budget + EXTERNAL_RETRY_*
 *   tuning, service='zen'), POST exactly once (non-idempotent — no retry opt-in).
 * - Errors: upstream 401/403 → 401 `opencode_key_invalid` (same as billing);
 *   429/5xx → fromStatus (EXTERNAL_RATE_LIMITED / EXTERNAL_UPSTREAM_5XX);
 *   anything else → fromStatus/fromUnknown (EXTERNAL_* envelope via
 *   ApiErrorFilter). A well-formed 200 without any chat text is a shape
 *   mismatch → 503, never a mock string.
 * - Logs: AppLogger one-liners with operation/status/code only (no URLs,
 *   headers, bodies or keys).
 */
@Injectable()
export class SessionRunnerService {
  constructor(
    private readonly keys: OpencodeKeysService,
    private readonly crypto: CryptoService,
    private readonly external: ExternalClient,
    private readonly logger: AppLogger = new AppLogger(SessionRunnerService.name),
  ) {}

  /** One assistant answer for the prompt (full text; the harness chunks it into SSE deltas). */
  async chat(userId: string, prompt: string, opts: ZenChatOptions = {}): Promise<string> {
    const cid = opts.correlationId;
    const stored = await this.keys.findByUserId(userId, cid);
    if (!stored || !stored.encryptedKey || !stored.iv) {
      throw new NotFoundException({
        code: 'opencode_key_missing',
        message: 'No OpenCode API key configured for this user',
      });
    }
    const apiKey = this.crypto.decrypt({
      keyId: stored.keyId,
      iv: stored.iv,
      data: stored.encryptedKey,
    });
    if (!this.crypto.isActiveKeyId(stored.keyId)) {
      try {
        const fresh = this.crypto.encrypt(apiKey);
        await this.keys.save(
          userId,
          { encryptedKey: fresh.data, iv: fresh.iv, keyId: fresh.keyId },
          cid,
        );
        this.logger.info('[zen] key re-encrypted', cid);
      } catch {
        this.logger.warn('[zen] lazy re-encrypt skipped', cid);
      }
    }

    let res: Response;
    // Inference API requires the plain Model ID from the models table
    // (docs: https://opencode.ai/v2/docs/console/models); the
    // `opencode/<model-id>` form exists only for opencode.jsonc selection.
    // Normalize defensively: keep the part after the last '/' so a
    // `providerID/modelID` ref degrades to the plain id; plain ids pass
    // through unchanged. The fallback default stays CLOUD_DEFAULT_MODEL.
    const rawModel =
      opts.model && opts.model.length > 0 ? opts.model : CLOUD_DEFAULT_MODEL;
    const slash = rawModel.lastIndexOf('/');
    const model = slash >= 0 ? rawModel.slice(slash + 1) : rawModel;
    // Local model guard (quota saver, same 400 envelope — the contract is
    // untouched): these ids can only fail the same way upstream, so reject
    // before any fetch instead of burning key quota.
    const guard = chatModelGuard(model);
    if (guard) {
      this.logger.warn(`[zen] chat model rejected model=${model} reason=${guard}`, cid);
      throw fromStatus('zen', 'chat', 400);
    }
    // Progressive upstream first: stream:true SSE so the harness can tail
    // message.part.delta frames while the answer is still arriving (chunks
    // accumulate here AND flow through onDelta). A stream that dies before the
    // first token falls back to one plain POST below (previous behavior);
    // after the first token the accumulator is the answer.
    const streamed = await this.chatStream(apiKey, model, prompt, cid, opts.onDelta);
    if (streamed !== null) {
      this.logger.info('[zen] chat answered stream', cid);
      return streamed;
    }
    try {
      res = await this.external.fetchWithRetry(
        ZEN_CHAT_URL,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
          }),
        },
        { service: 'zen', operation: 'chat', correlationId: cid, timeoutMs: CHAT_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof ExternalServiceError || err instanceof HttpException) throw err;
      throw fromUnknown('zen', 'chat', err);
    }

    if (res.status === 401 || res.status === 403) {
      await res.arrayBuffer().catch(() => null);
      this.logger.warn(`[zen] chat rejected status=${res.status} code=opencode_key_invalid`, cid);
      throw new UnauthorizedException({
        code: 'opencode_key_invalid',
        message: 'OpenCode API key was rejected',
      });
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => null);
      const mapped = fromStatus('zen', 'chat', res.status);
      this.logger.warn(
        `[zen] chat upstream status=${res.status} code=${mapped.code} endpoint=/inference/openai/v1/chat/completions model=${model}`,
        cid,
      );
      throw mapped;
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      await res.arrayBuffer().catch(() => null);
      this.logger.warn('[zen] chat bad json code=EXTERNAL_UNAVAILABLE', cid);
      throw fromUnknown('zen', 'chat', new Error('bad_chat_json'));
    }
    const text = extractText(payload);
    if (!text) {
      this.logger.warn('[zen] chat shape mismatch code=EXTERNAL_UNAVAILABLE', cid);
      throw fromUnknown('zen', 'chat', new Error('bad_chat_shape'));
    }
    this.logger.info('[zen] chat answered', cid);
    return text;
  }

  /**
   * Progressive attempt: POST stream:true, parse OpenAI SSE data: lines
   * (choices[0].delta.content — same branch the CLI extractCloudText reads in
   * apps/cli/src/agents/opencode/text.ts). Returns the full text once ≥1
   * token arrived (a mid-stream abort keeps the partial accumulator); null
   * when nothing arrived (the caller falls back to one plain POST). 401/403
   * keeps the billing-compatible invalid-key throw — no fallback against
   * refused credentials. Bearer/endpoint/model handling matches chat().
   */
  private async chatStream(
    apiKey: string,
    model: string,
    prompt: string,
    cid: string | undefined,
    onDelta?: (chunk: string) => void,
  ): Promise<string | null> {
    let res: Response;
    try {
      res = await this.external.fetchWithRetry(
        ZEN_CHAT_URL,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
          }),
        },
        { service: 'zen', operation: 'chat', correlationId: cid, timeoutMs: CHAT_TIMEOUT_MS },
      );
    } catch {
      // Pre-token transport failure (timeout/network/429/5xx) — the plain
      // POST below decides honestly (it owns the 429/5xx mapping).
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      await res.arrayBuffer().catch(() => null);
      this.logger.warn(`[zen] chat rejected status=${res.status} code=opencode_key_invalid`, cid);
      throw new UnauthorizedException({
        code: 'opencode_key_invalid',
        message: 'OpenCode API key was rejected',
      });
    }
    if (!res.ok || !res.body) {
      await res.arrayBuffer().catch(() => null);
      return null;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let acc = '';
    const feed = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return false;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return false;
      }
      const delta = extractStreamDelta(parsed);
      if (delta) {
        acc += delta;
        try {
          onDelta?.(delta);
        } catch {
          /* progress sink is best-effort — never fails the answer */
        }
      }
      return false;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf('\n');
          while (idx >= 0) {
            if (feed(buf.slice(0, idx))) {
              await reader.cancel().catch(() => null);
              return acc.length > 0 ? acc : null;
            }
            buf = buf.slice(idx + 1);
            idx = buf.indexOf('\n');
          }
        }
        if (done) break;
      }
      buf += decoder.decode();
      if (buf.trim().length > 0) feed(buf);
      return acc.length > 0 ? acc : null;
    } catch {
      // Timeout/abort mid-stream: keep whatever arrived (null → plain POST).
      await reader.cancel().catch(() => null);
      return acc.length > 0 ? acc : null;
    }
  }
}
