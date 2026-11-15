import { HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { AppLogger } from '../logger';
import { ExternalClient } from '../external/external-client';
import { ExternalServiceError, fromStatus, fromUnknown } from '../external/external-error';
import { CryptoService, type EncryptedOpencodeKey } from '../crypto/crypto.service';
import { OPENCODE_PROVIDER } from '../vault/vault.providers';
import { VaultService } from '../vault/vault.service';
import type { VaultSecret } from '../vault/vault.types';

/**
 * Direct cloud chat endpoint (module constant, same precedent as
 * BillingService.BILLING_URL: no env override — the endpoint is fixed).
 *
 * Provenance: apps/cli/src/agents/opencode/constants.ts OPENCODE_CLOUD_URL
 * (documented inference endpoint, see apps/cli/README.md §Chat) —
 * OpenAI-compatible POST {model, messages:[{role:'user', content}]} →
 * choices text, Bearer, timeout 30s (apps/cli/src/agents/opencode/cloud.ts).
 */
export const ZEN_CHAT_URL: string = 'https://opencode.ai/inference/openai/v1/chat/completions';

/**
 * Default cloud model, plain id (provenance: apps/cli constants
 * OPENCODE_CLOUD_MODEL='deepseek-v4.1-flash'; CLI cloud sends the plain id
 * via resolveCloudModel). The endpoint requires `model` in every body.
 */
export const CLOUD_DEFAULT_MODEL: string = 'deepseek-v4.1-flash';

export type ZenChatOptions = {
  /**
   * Plain upstream Model ID (CLOUD_DEFAULT_MODEL when omitted; a legacy
   * `providerID/modelID` ref is normalized to the part after the last '/').
   */
  model?: string;
  /** Traced through every attempt log line (never logged as a secret). */
  correlationId?: string;
  /**
   * OpenAI-compatible system role: when set, messages become
   * [{role:'system',content:system},{role:'user',content:prompt}] in both
   * the stream and the fallback plain POST bodies; omitted → user-only
   * messages exactly as before (additive, default unchanged).
   */
  system?: string;
  /**
   * Progressive sink: the stream:true attempt calls it per SSE delta chunk
   * (the harness tails message.part.delta frames through it while the answer
   * is still arriving). Best-effort — a throwing sink never fails the answer.
   */
  onDelta?: (chunk: string) => void;
};

/** Per-attempt budget for chat (the 10s default kills slow answers mid-stream). */
const CHAT_TIMEOUT_MS: number = 90000;

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
  const id: string = model.toLowerCase();
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
  const choices: unknown = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const delta: unknown = (first as { delta?: unknown }).delta;
  if (typeof delta !== 'object' || delta === null) return null;
  const content: unknown = (delta as { content?: unknown }).content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/** One choice entry of an OpenAI-compatible chat payload (only what is read). */
type ZenChatChoice = { message?: { content?: unknown }; text?: unknown };

/** Narrowed OpenAI-compatible chat payload members (only what the projection reads). */
type ZenChatResponse = {
  choices?: Array<ZenChatChoice>;
  text?: unknown;
  content?: unknown;
  answer?: unknown;
};

function extractText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record: ZenChatResponse = payload as ZenChatResponse;
  const choices: Array<ZenChatChoice> | undefined = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first: ZenChatChoice | undefined = choices[0];
    const content: unknown = first?.message?.content;
    if (typeof content === 'string' && content.length > 0) return content;
    if (typeof first?.text === 'string' && first.text.length > 0) return first.text;
  }
  for (const key of ['text', 'content', 'answer'] as const) {
    const value: unknown = record[key];
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
 * - Key: the caller's secret from VaultService (round-robin across the
 *   caller's rows for the provider), decrypted in memory via CryptoService
 *   (existing keys-rotation: dual-read + lazy re-encrypt under the active KEK
 *   — same lines as BillingService.getUsage; billing is untouched).
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
    private readonly keys: VaultService,
    private readonly crypto: CryptoService,
    private readonly external: ExternalClient,
    private readonly logger: AppLogger = new AppLogger(SessionRunnerService.name),
  ) {}

  /** One assistant answer for the prompt (full text; the harness chunks it into SSE deltas). */
  async chat(userId: string, prompt: string, options: ZenChatOptions = {}): Promise<string> {
    const correlationId: string | undefined = options.correlationId;
    const stored: VaultSecret | null = await this.keys.pickNext(
      { kind: 'user', userId },
      OPENCODE_PROVIDER,
      correlationId,
    );
    if (!stored || !stored.encryptedKey || !stored.iv) {
      throw new NotFoundException({
        code: 'opencode_key_missing',
        message: 'No OpenCode API key configured for this user',
      });
    }
    const apiKey: string = this.crypto.decrypt({
      keyId: stored.keyId,
      iv: stored.iv,
      data: stored.encryptedKey,
    });
    if (!this.crypto.isActiveKeyId(stored.keyId)) {
      try {
        const fresh: EncryptedOpencodeKey = this.crypto.encrypt(apiKey);
        await this.keys.rewrap(
          { kind: 'user', userId },
          stored.id,
          {
            encryptedKey: fresh.data,
            iv: fresh.iv,
            keyId: fresh.keyId,
          },
          correlationId,
        );
        this.logger.info('[zen] key re-encrypted', correlationId);
      } catch {
        this.logger.warn('[zen] lazy re-encrypt skipped', correlationId);
      }
    }

    let response: Response;
    // Inference API requires the plain Model ID from the models table
    // (docs: https://opencode.ai/v2/docs/console/models); the
    // `opencode/<model-id>` form exists only for opencode.jsonc selection.
    // Normalize defensively: keep the part after the last '/' so a
    // `providerID/modelID` ref degrades to the plain id; plain ids pass
    // through unchanged. The fallback default stays CLOUD_DEFAULT_MODEL.
    const rawModel: string =
      options.model && options.model.length > 0 ? options.model : CLOUD_DEFAULT_MODEL;
    const slash: number = rawModel.lastIndexOf('/');
    const model: string = slash >= 0 ? rawModel.slice(slash + 1) : rawModel;
    // Local model guard (quota saver, same 400 envelope — the contract is
    // untouched): these ids can only fail the same way upstream, so reject
    // before any fetch instead of burning key quota.
    const guard: ReturnType<typeof chatModelGuard> = chatModelGuard(model);
    if (guard) {
      this.logger.warn(`[zen] chat model rejected model=${model} reason=${guard}`, correlationId);
      throw fromStatus('zen', 'chat', 400);
    }
    // Progressive upstream first: stream:true SSE so the harness can tail
    // message.part.delta frames while the answer is still arriving (chunks
    // accumulate here AND flow through onDelta). A stream that dies before the
    // first token falls back to one plain POST below (previous behavior);
    // after the first token the accumulator is the answer.
    // OpenAI-compatible system role (optional): system-first messages in
    // both bodies; without `system` the payload stays user-only as before.
    const messages: Array<{ role: string; content: string }> =
      options.system && options.system.length > 0
        ? [
            { role: 'system', content: options.system },
            { role: 'user', content: prompt },
          ]
        : [{ role: 'user', content: prompt }];
    const streamed: string | null = await this.chatStream(
      apiKey,
      model,
      messages,
      correlationId,
      options.onDelta,
    );
    if (streamed !== null) {
      this.logger.info('[zen] chat answered stream', correlationId);
      return streamed;
    }
    try {
      response = await this.external.fetchWithRetry(
        ZEN_CHAT_URL,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
          }),
        },
        { service: 'zen', operation: 'chat', correlationId, timeoutMs: CHAT_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof ExternalServiceError || error instanceof HttpException) throw error;
      throw fromUnknown('zen', 'chat', error);
    }

    if (response.status === 401 || response.status === 403) {
      await response.arrayBuffer().catch(() => null);
      this.logger.warn(`[zen] chat rejected status=${response.status} code=opencode_key_invalid`, correlationId);
      throw new UnauthorizedException({
        code: 'opencode_key_invalid',
        message: 'OpenCode API key was rejected',
      });
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => null);
      const mapped: ExternalServiceError = fromStatus('zen', 'chat', response.status);
      this.logger.warn(
        `[zen] chat upstream status=${response.status} code=${mapped.code} endpoint=/inference/openai/v1/chat/completions model=${model}`,
        correlationId,
      );
      throw mapped;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      await response.arrayBuffer().catch(() => null);
      this.logger.warn('[zen] chat bad json code=EXTERNAL_UNAVAILABLE', correlationId);
      throw fromUnknown('zen', 'chat', new Error('bad_chat_json'));
    }
    const text: string | null = extractText(payload);
    if (!text) {
      this.logger.warn('[zen] chat shape mismatch code=EXTERNAL_UNAVAILABLE', correlationId);
      throw fromUnknown('zen', 'chat', new Error('bad_chat_shape'));
    }
    this.logger.info('[zen] chat answered', correlationId);
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
    messages: ReadonlyArray<{ role: string; content: string }>,
    correlationId: string | undefined,
    onDelta?: (chunk: string) => void,
  ): Promise<string | null> {
    let response: Response;
    try {
      response = await this.external.fetchWithRetry(
        ZEN_CHAT_URL,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
          }),
        },
        { service: 'zen', operation: 'chat', correlationId, timeoutMs: CHAT_TIMEOUT_MS },
      );
    } catch {
      // Pre-token transport failure (timeout/network/429/5xx) — the plain
      // POST below decides honestly (it owns the 429/5xx mapping).
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      await response.arrayBuffer().catch(() => null);
      this.logger.warn(`[zen] chat rejected status=${response.status} code=opencode_key_invalid`, correlationId);
      throw new UnauthorizedException({
        code: 'opencode_key_invalid',
        message: 'OpenCode API key was rejected',
      });
    }
    if (!response.ok || !response.body) {
      await response.arrayBuffer().catch(() => null);
      return null;
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> =
      response.body.getReader();
    const decoder: InstanceType<typeof TextDecoder> = new TextDecoder();
    let buffer: string = '';
    let accumulator: string = '';
    const feed: (line: string) => boolean = (line: string): boolean => {
      const trimmed: string = line.trim();
      if (!trimmed.startsWith('data:')) return false;
      const payload: string = trimmed.slice(5).trim();
      if (payload === '[DONE]') return true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return false;
      }
      const delta: string | null = extractStreamDelta(parsed);
      if (delta) {
        accumulator += delta;
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
          buffer += decoder.decode(value, { stream: true });
          let index: number = buffer.indexOf('\n');
          while (index >= 0) {
            if (feed(buffer.slice(0, index))) {
              await reader.cancel().catch(() => null);
              return accumulator.length > 0 ? accumulator : null;
            }
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
          }
        }
        if (done) break;
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) feed(buffer);
      return accumulator.length > 0 ? accumulator : null;
    } catch {
      // Timeout/abort mid-stream: keep whatever arrived (null → plain POST).
      await reader.cancel().catch(() => null);
      return accumulator.length > 0 ? accumulator : null;
    }
  }
}
