import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppLogger } from '../logger';
import { ExternalClient } from '../external/external-client';
import { ExternalServiceError, fromStatus, fromUnknown } from '../external/external-error';
import { CryptoService, type EncryptedOpencodeKey } from '../crypto/crypto.service';
import { OPENCODE_PROVIDER } from '../vault/vault.providers';
import { VaultService } from '../vault/vault.service';
import type { VaultSecret } from '../vault/vault.types';

/**
 * Paid System One classifier endpoint (module constant, same precedent as
 * SessionRunnerService.ZEN_CHAT_URL: no env override — the endpoint is fixed).
 */
export const JEV_SYSTEMONE_URL: string = 'https://opencode.ai/inference/systemone/v1/systemone';

/**
 * Paid routing model, per requirements — NOT jev-1.13-free (the free id is
 * the docs/chat-tier id; routing bills pay-as-you-go on jev-1.13).
 */
export const JEV_ROUTE_MODEL: string = 'jev-1.13';

/** Question state budget: the classifier sees the question truncated to 2000 chars. */
const ROUTE_STATE_LIMIT: number = 2000;

/** Confidence gate: a Jev choice below 0.5 is not trusted (fallback, never thrown). */
const ROUTE_MIN_CONFIDENCE: number = 0.5;

export type JevRoute = 'backend' | 'frontend' | 'fullstack' | 'ask' | 'unclear';

/** Concrete route the classifier may decide (everything but the honest 'unclear'). */
export type JevDecidedRoute = Exclude<JevRoute, 'unclear'>;

export type JevClassifyResult = {
  route: JevRoute;
  /** Jev choice confidence (absent on heuristic fallback). */
  confidence?: number;
  /** Which path decided the route (jev choice vs local heuristic). */
  provider: 'jev' | 'heuristic';
};

export type JevClassifyOptions = {
  /** Traced through every log line (never logged as a secret). */
  correlationId?: string;
};

/** Upstream systemone route answer (only the members this classifier reads). */
type JevSystemOneRoute = {
  choice: string;
  confidence?: unknown;
};

/** Systemone answer members this classifier reads (everything else is dropped). */
type JevSystemOneAnswer = {
  answers?: { route?: JevSystemOneRoute };
};

/**
 * Minimal systemone answer shape — only answers.route.choice/confidence.
 * Everything else is tolerated (plain z.object strips unknown keys, so extra
 * questions/fields never fail the parse; missing route → shape fallback).
 */
const jevSystemOneSchema: z.ZodType<JevSystemOneAnswer> = z.object({
  answers: z
    .object({
      route: z
        .object({
          choice: z.string(),
          confidence: z.unknown().optional(),
        })
        .optional(),
    })
    .optional(),
});

const ROUTE_CHOICES: ReadonlySet<string> = new Set(['backend', 'frontend', 'fullstack', 'ask']);

const FRONTEND_MARKERS: RegExp =
  /(ui|в[её]рстк|верста|react|next|компонент|страниц|стил|хук|фронт|интерфейс|кнопк|форм|css|tailwind)/i;

const BACKEND_MARKERS: RegExp =
  /(сервер|api|бд|баз[аы] данных|nest|drizzle|контроллер|миграци|сервис|endpoint|эндпоинт|postgres|sql|бэкенд|бэк)/i;

const FULLSTACK_MARKERS: RegExp =
  /(связк|фронт.*бэк|бэк.*фронт|frontend.*backend|backend.*frontend|интеграци|сквозн|обе стороны|end-to-end|контракт)/i;

const ASK_MARKERS: RegExp =
  /(что|как|почему|зачем|объясни|расскажи|подскажи|explain|what|why|how)/i;

/**
 * Local domain heuristic (deterministic markers when Jev is unavailable):
 * frontend markers → frontend, backend markers → backend, both sides or
 * integration words → fullstack, ask markers (question/answer without code
 * changes) with no domain markers → 'ask', NOTHING → 'unclear' (never guess
 * — the caller answers honestly instead of hallucinating a domain).
 */
function heuristicRoute(question: string): JevRoute {
  const hasFull: boolean = FULLSTACK_MARKERS.test(question);
  const hasFront: boolean = FRONTEND_MARKERS.test(question);
  const hasBack: boolean = BACKEND_MARKERS.test(question);
  if (hasFull || (hasFront && hasBack)) return 'fullstack';
  if (hasFront) return 'frontend';
  if (hasBack) return 'backend';
  if (ASK_MARKERS.test(question)) return 'ask';
  return 'unclear';
}

/**
 * SCOPE: Common — reusable routing transport, no organization/project knowledge.
 *
 * JevService — paid System One choice classifier (NOT a chat model: no AI SDK
 * row, direct HTTPS like tools/classify_build.ts lines 161-174, reused 1:1):
 * POST {model:'jev-1.13', state, questions:{route:{type:'choice',
 * instructions, criteria:{backend,frontend,fullstack,ask}}}} →
 * answers.route.{choice,confidence}.
 *
 * - Key: the caller's secret from VaultService (round-robin across the
 *   caller's rows for the provider), decrypted in memory via CryptoService —
 *   same key-load block as SessionRunnerService.chat (existing keys-rotation:
 *   dual-read + lazy re-encrypt under the active KEK). The plaintext lives
 *   only in this request (upstream Bearer) and is never logged (presence only,
 *   never the value).
 * - Transport: ExternalClient (default budget — Jev is fast), POST exactly
 *   once (non-idempotent — no allowNonIdempotentRetry opt-in),
 *   service='jev' (distinguishable from 'zen' chat in logs),
 *   operation='classify'.
 * - Errors NEVER propagate: 401/403/400/429/5xx, network/timeout, bad json,
 *   bad shape, choice outside {backend,frontend,fullstack,ask}, confidence < 0.5,
 *   missing/unreadable key — all return the honest heuristic domain (or
 *   'ask' on question markers, 'unclear' when nothing matches) with a warn
 *   one-liner carrying only the code (no bodies). Success returns
 *   {route, confidence} with an info one-liner. The error envelope is
 *   untouched: the caller's chain still answers its own honest 404/500 on
 *   the next hop.
 * - Cost note: +1 paid Jev call on every Auto request (pay-as-you-go
 *   jev-1.13), including ask-routed questions answered directly without a
 *   chain. The domain-routed chain it unlocks saves misrouted calls; the
 *   classify call itself always bills once.
 * - Logs: AppLogger one-liners with route/confidence/code/provider only (no
 *   URLs, headers, bodies or keys).
 */
@Injectable()
export class JevService {
  constructor(
    private readonly keys: VaultService,
    private readonly crypto: CryptoService,
    private readonly external: ExternalClient,
    private readonly logger: AppLogger = new AppLogger(JevService.name),
  ) {}

  /** Route the question to a domain agent (never throws). */
  async classify(
    question: string,
    userId: string,
    options: JevClassifyOptions = {},
  ): Promise<JevClassifyResult> {
    const correlationId: string | undefined = options.correlationId;
    const state: string = question.slice(0, ROUTE_STATE_LIMIT);

    let apiKey: string;
    try {
      const stored: VaultSecret | null = await this.keys.pickNext(
        { kind: 'user', userId },
        OPENCODE_PROVIDER,
        correlationId,
      );
      if (!stored || !stored.encryptedKey || !stored.iv) {
        return this.fallback('opencode_key_missing', question, correlationId);
      }
      apiKey = this.crypto.decrypt({
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
          this.logger.info('[jev] key re-encrypted', correlationId);
        } catch {
          this.logger.warn('[jev] lazy re-encrypt skipped', correlationId);
        }
      }
    } catch (error) {
      const code: string =
        error instanceof ExternalServiceError
          ? error.code
          : fromUnknown('jev', 'classify', error).code;
      return this.fallback(code, question, correlationId);
    }

    let response: Response;
    try {
      response = await this.external.fetchWithRetry(
        JEV_SYSTEMONE_URL,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: JEV_ROUTE_MODEL,
            state,
            questions: {
              route: {
                type: 'choice',
                instructions:
                  'Определи, к какому домену относится запрос пользователя: backend, frontend, fullstack или ask.',
                criteria: {
                  backend:
                    'сервер/API/БД: Nest, Drizzle, контроллеры, сервисы, миграции, база данных',
                  frontend:
                    'UI/вёрстка: React, Next, компоненты, страницы, хуки, стили',
                  fullstack:
                    'связка фронта и бэка: интеграция, сквозная задача, упоминаются обе стороны, контракты',
                  ask: 'простой вопрос/ответ без изменений кода (что это, как работает, объясни, подскажи, разница между, зачем нужен) — ответы без декомпозиции и цепочки шагов',
                },
              },
            },
          }),
        },
        { service: 'jev', operation: 'classify', correlationId },
      );
    } catch (error) {
      const code: string =
        error instanceof ExternalServiceError
          ? error.code
          : fromUnknown('jev', 'classify', error).code;
      return this.fallback(code, question, correlationId);
    }

    if (!response.ok) {
      await response.arrayBuffer().catch(() => null);
      return this.fallback(
        fromStatus('jev', 'classify', response.status).code,
        question,
        correlationId,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      await response.arrayBuffer().catch(() => null);
      return this.fallback('bad_json', question, correlationId);
    }
    const parsed: ReturnType<typeof jevSystemOneSchema.safeParse> =
      jevSystemOneSchema.safeParse(payload);
    const route: JevSystemOneRoute | undefined = parsed.success
      ? parsed.data.answers?.route
      : undefined;
    if (!route) {
      return this.fallback('bad_shape', question, correlationId);
    }
    if (!ROUTE_CHOICES.has(route.choice)) {
      return this.fallback('unknown_choice', question, correlationId);
    }
    if (typeof route.confidence !== 'number' || route.confidence < ROUTE_MIN_CONFIDENCE) {
      return this.fallback('low_confidence', question, correlationId);
    }
    const decision: JevDecidedRoute = route.choice as JevDecidedRoute;
    this.logger.info(
      `[jev] classify route=${decision} confidence=${route.confidence} provider=jev`,
      correlationId,
    );
    return { route: decision, confidence: route.confidence, provider: 'jev' };
  }

  /** Local fallback: honest heuristic domain (or 'unclear'), never a guessed chain. */
  private fallback(
    code: string,
    question: string,
    correlationId: string | undefined,
  ): JevClassifyResult {
    const heuristic: JevRoute = heuristicRoute(question);
    this.logger.warn(
      `[jev] classify fallback code=${code} provider=heuristic route=${heuristic}`,
      correlationId,
    );
    return { route: heuristic, provider: 'heuristic' };
  }
}
