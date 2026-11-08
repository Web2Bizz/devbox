# code-agent — read-only пример (draft-stand, не прод)

Пример агента вывода кода: системный промпт + опционально user prompt →
код/текст модели + мета. Без записи файлов, без исполнения инструментов.

## Файлы (3 новых, прод не тронут)

- `code-agent.ts` — реализация + типы (`runCodeAgent`, `TRANSPORT`,
  `UPSTREAM_PROVIDER`, `OPENAI_BASE_URL`, `DEFAULT_MODEL_ID`).
- `code-agent.verify.ts` — тест-прогон (reuse `run.ts` + `assertions.ts`).
- `code-agent.README.md` — этот файл.

## Сигнатура

```ts
import { runCodeAgent } from './code-agent';

const out = await runCodeAgent({
  systemPrompt: 'You are a read-only code assistant...',
  userPrompt: 'Say OK.',   // опционально
  apiKey,                  // per-user из auth.json, только в памяти
  // modelId?, signal?
});
// out: { text, model, provider, transport, usage?, dispatchCalls: 0 }
```

- Вход: `systemPrompt: string` (обязателен), `userPrompt?: string`,
  `apiKey: string` (per-user, в памяти), `modelId?`, `signal?`.
- Выход: `text: string`, `model`, `provider: 'opencode'`,
  `transport: 'inprocess-opencode'`, `usage?`, `dispatchCalls: 0`.

## Как вызывать

```sh
# из apps/backend
bun ./draft-stand/code-agent.verify.ts
```

- Без `auth.json` — честный SKIP вызова модели (R1/R4/secret-scan всё равно).
- С ключом — один вызов `generate`, отчёт без секретов
  (`path/field/key_len`, `text_len`, `usage`). Ключ ищется как в `run.ts`:
  `.opencode/auth.json` → `~/.config/opencode/auth.json` →
  `~/.local/share/opencode/auth.json` (`XDG_DATA_HOME` override),
  приоритет `opencode-go` > `opencode`.

## Транспорт (почему `make()`)

В пине `@opencode/ai@2.2.5` НЕТ `LLM`-экспорта:
`dist/index.js` отдаёт только `make/ai/tool/...`,
`LLM` — лишь Effect API (`dist/effect.js`) и тип (`dist/index.d.ts`).
Поэтому используем promise-first Effect-рантайм `make()`:

```ts
const { make } = await import('@opencode/ai');
const client = make();
const res = await client.generate({ model, system, prompt, tools: [] });
await client.dispose();
```

Модель: `openai-compatible` роут на официальную Inference API
(`https://opencode.ai/inference/openai/v1` + `/chat/completions`,
дока `opencode.ai/v2/docs/console/api/inference`), `provider: 'opencode'`
override, per-call `apiKey`. Дефолт `deepseek-v4.1-flash` — reuse
`ASK_FALLBACK_MODELS[0]`.

## Запреты (соблюдены)

- Нет `LLM.loop`, нет `sessions.create/prompt` (`@opencode/sdk`).
- Нет sidecar/прокси/CLI, нет конфиг-файлов, нет записи ФС.
- Инструменты: ноль (`tools: []`), `ToolDispatchService` не импортируется,
  `dispatchCalls` всегда `0`.
- Ключ: только в памяти (`key_len` в лог, значение никогда).

## Reuse-first

- `run.ts`: `resolveKey`, `gitPorcelain`, `secretScanSelf` (паттерн).
- `assertions.ts`: `assertR2`, `assertR4` (импорт).
- `agents/model-fallback.ts`: `ASK_FALLBACK_MODELS[0]` (дефолт модели).
- `OpencodeHostService`: каталог моделей R6 (здесь не нужен, SKIP без ключа).
