/**
 * draft-stand/code-agent — read-only пример агента вывода кода (не прод).
 *
 * Контракт:
 * - Вход: system prompt (string) + опционально user prompt. Ключ per-user
 *   передаётся вызывающим кодом (из auth.json в памяти, см. verify-скрипт).
 * - Выход: код/текст модели (string) + мета (model, provider, usage).
 *   Без записи файлов, без исполнения инструментов.
 *
 * Транспорт (по исходникам пина `@opencode/ai@2.2.5` внутри репо):
 * - `LLM`-экспорта НЕТ: `node_modules/@opencode/ai/dist/index.js` экспортирует
 *   только `make/ai/tool/...` (`export const make`, `export const ai`,
 *   `export const tool`), прямого `LLM` там нет; `LLM` живёт только как
 *   Effect API в `dist/effect.js` (`ai.request/generate/stream/loop`) и как
 *   тип в `dist/index.d.ts` (`export type { LLM }`). Поэтому НЕ выдумываем
 *   `LLM.stream` напрямую — используем promise-first Effect-рантайм `make()`
 *   (`ManagedRuntime` внутри, `client.generate`), что и есть правильный путь.
 * - Запрещены и НЕ используются: `LLM.loop`, `sessions.create/prompt`
 *   (`@opencode/sdk`), sidecar/прокси/CLI, конфиг-файлы (`llm.config.json`,
 *   `opencode.json` не читается), запись ФС, исполнение инструментов.
 *
 * Инструменты: только LangChain — здесь их ноль (чистая модель, tools: []).
 * `ToolDispatchService` не импортируется, счётчик dispatch = 0 по построению.
 *
 * Провайдер кодом (константы ниже, не конфиг-файлы):
 * - `TRANSPORT = 'inprocess-opencode'` — наш id из PLAN §2 (in-process вызов
 *   модели через `@opencode/ai`, без агента).
 * - Upstream — OpenAI-совместимый chat роут на официальную Inference API:
 *   `OPENAI_BASE_URL = 'https://opencode.ai/inference/openai/v1'`
 *   (источник — официальная дока `opencode.ai/v2/docs/console/api/inference`:
 *   `POST https://opencode.ai/inference/openai/v1/chat/completions`,
 *   `Authorization: Bearer <token>`; роут `openai-compatible-chat` добавляет
 *   `/chat/completions` к baseURL — см. `protocols/openai-compatible-chat.js`).
 * - `UPSTREAM_PROVIDER = 'opencode'` — override провайдера в
 *   `openai-compatible.configure({ provider })` (поддержано исходником:
 *   `providers/openai-compatible.js: const provider = input.provider ?? ...`).
 * - `DEFAULT_MODEL_ID = 'deepseek-v4.1-flash'` — reuse
 *   `ASK_FALLBACK_MODELS[0]` (`agents/model-fallback.ts`); chat-семейство
 *   (примеры доки: `glm-5.3`, `kimi-k3`, `minimax-m3` — тот же chat endpoint).
 *
 * Ключ: только per-user из памяти (`apiKey` в `CodeAgentInput`), в логи/файлы/
 * коммит не попадает никогда. Поиск ключа — в verify-скрипте по образцу
 * `run.ts: resolveKey` (auth.json, приоритет `opencode-go` > `opencode`).
 *
 * Reuse-first (не дублируем прод-логику):
 * - `run.ts` — образец `resolveKey`, `gitPorcelain`, `secretScanSelf`.
 * - `assertions.ts` — проверки R2/R4 в verify-скрипте.
 * - `OpencodeHostService` (`provider.list`/`model.list`) — только каталог
 *   моделей R6, здесь не нужен (verify честно SKIP без сети при отсутствии ключа).
 * - `model-fallback.ts ASK_FALLBACK_MODELS` — дефолтная модель.
 *
 * Файлов: 3 новых — `code-agent.ts` (этот, типы внутри),
 * `code-agent.verify.ts` (прогон), `code-agent.README.md` (пример).
 */

export const TRANSPORT = 'inprocess-opencode' as const;

/** Upstream provider id (override для openai-compatible роута). */
export const UPSTREAM_PROVIDER = 'opencode' as const;

/**
 * Chat baseURL официальной Inference API (дока opencode.ai/v2/docs/.../inference).
 * Роут добавит `/chat/completions`.
 */
export const OPENAI_BASE_URL = 'https://opencode.ai/inference/openai/v1' as const;

/** Дефолтная модель — reuse ASK_FALLBACK_MODELS[0]. */
export const DEFAULT_MODEL_ID = 'deepseek-v4.1-flash' as const;

/** Ожидаемый точный пин прямой зависимости (как в run.ts R2). */
export const EXPECTED_AI_VERSION = '2.2.5' as const;

export type CodeAgentInput = {
  /** Системный промпт (string, обязателен, непустой). */
  systemPrompt: string;
  /** Пользовательский промпт (опционально). */
  userPrompt?: string;
  /** Per-user ключ из auth.json — только в памяти, никогда в логи. */
  apiKey: string;
  /** Override модели (по умолчанию DEFAULT_MODEL_ID). */
  modelId?: string;
  /** Abort для отмены (прокидывается в generate). */
  signal?: AbortSignal;
};

export type CodeAgentUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type CodeAgentOutput = {
  /** Код/текст модели. */
  readonly text: string;
  /** Фактическая модель (echo запроса). */
  readonly model: string;
  /** Upstream provider (`opencode`). */
  readonly provider: typeof UPSTREAM_PROVIDER;
  /** Наш транспорт (`inprocess-opencode`). */
  readonly transport: typeof TRANSPORT;
  /** Usage провайдера (если отдал). */
  readonly usage?: CodeAgentUsage;
  /** Счётчик ToolDispatchService — всегда 0 (исполнения нет). */
  readonly dispatchCalls: 0;
};

type MakeClient = {
  generate: (input: unknown, options?: { signal?: AbortSignal }) => Promise<{
    text: string;
    usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown };
  }>;
  dispose: () => Promise<void>;
};

function fail(message: string): never {
  throw new Error(`[code-agent] ${message}`);
}

/**
 * Один вызов чистой модели (read-only, tools: []), без агента и без loop.
 *
 * Сигнатура входа/выхода:
 *   in:  { systemPrompt, userPrompt?, apiKey, modelId?, signal? }
 *   out: Promise<{ text, model, provider, transport, usage?, dispatchCalls: 0 }>
 */
export async function runCodeAgent(input: CodeAgentInput): Promise<CodeAgentOutput> {
  const systemPrompt = input.systemPrompt?.trim() ?? '';
  if (!systemPrompt) fail('systemPrompt is required (non-empty string, no fallback)');
  const apiKey = input.apiKey ?? '';
  if (!apiKey.trim()) fail('apiKey is required (per-user, in-memory only, no fallback)');
  const modelId = (input.modelId ?? '').trim() || DEFAULT_MODEL_ID;

  // Effect-рантайм make() — единственный транспорт (LLM-экспорта нет в 2.2.5).
  let makeFn: (() => MakeClient) | undefined;
  try {
    const aiMod = (await import('@opencode/ai')) as unknown as Record<string, unknown>;
    if (typeof aiMod['make'] === 'function') makeFn = aiMod['make'] as () => MakeClient;
  } catch {
    // ниже — честная ошибка без секретов
  }
  if (!makeFn) fail('@opencode/ai make() unavailable (pin 2.2.5 changed?)');

  // Chat-модель с per-call ключом: openai-compatible роут на Inference API.
  // `opencode`-провайдер в пине отдаёт только decision (SystemOne), chat там
  // нет — поэтому chat идёт через openai-compatible с provider override.
  let languageModel: unknown;
  try {
    const compat = (await import('@opencode/ai/providers/openai-compatible')) as unknown as {
      model: (id: string, settings: Record<string, unknown>) => unknown;
    };
    if (typeof compat.model !== 'function') fail('openai-compatible model() missing in pin');
    languageModel = compat.model(modelId, {
      apiKey,
      baseURL: OPENAI_BASE_URL,
      provider: UPSTREAM_PROVIDER,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('[code-agent]')) throw err;
    fail('failed to build LanguageModel (openai-compatible route)');
  }

  const client = makeFn();
  try {
    const request = {
      model: languageModel,
      system: systemPrompt,
      prompt: input.userPrompt ?? '',
      // read-only: ноль инструментов (эквивалент tools:false).
      tools: [] as Array<never>,
    };
    const response = await client.generate(
      request,
      input.signal ? { signal: input.signal } : undefined,
    );
    const text = typeof response.text === 'string' ? response.text : '';
    const raw = (response.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const usage: CodeAgentUsage | undefined =
      num(raw['inputTokens']) !== undefined ||
      num(raw['outputTokens']) !== undefined ||
      num(raw['totalTokens']) !== undefined
        ? {
            ...(num(raw['inputTokens']) !== undefined ? { inputTokens: num(raw['inputTokens']) } : {}),
            ...(num(raw['outputTokens']) !== undefined ? { outputTokens: num(raw['outputTokens']) } : {}),
            ...(num(raw['totalTokens']) !== undefined ? { totalTokens: num(raw['totalTokens']) } : {}),
          }
        : undefined;
    return {
      text,
      model: modelId,
      provider: UPSTREAM_PROVIDER,
      transport: TRANSPORT,
      ...(usage ? { usage } : {}),
      dispatchCalls: 0,
    };
  } finally {
    await client.dispose().catch(() => undefined);
  }
}
