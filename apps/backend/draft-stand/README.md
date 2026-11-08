# draft-stand — проверка `LLM.stream` без агента (S0, R1–R6)

Переиспользуемый пример. Только новые файлы, прод-код не трогается.

## Что это

Минимальный стенд, который вызывает модель OpenCode через `@opencode/ai`
`LLM.stream` **без агента, без `LLM.loop`, без `sessions.create/prompt`**,
с `bind_tools`-описанием `[git.recon]`, и доказывает R1–R6 из
`.plans/langchain-openrouter-migration/PLAN.md` §3.

## Файлы

- `run.ts` — стенд: поиск `auth.json`, сборка вызова, `LLM.stream` с tools,
  счётчик `ToolDispatchService` (=0), `git status` до/после, проверка
  `tool_calls`/SSE/`usage`, вывод PASS/FAIL по каждому R без секретов.
- `assertions.ts` — чистые проверки R1–R6 (без I/O, без секретов).
- `README.md` — этот файл (пример запуска).

## Reuse-first (не дублируем)

- `OpencodeHostService` (`provider.list`/`model.list` для R6) —
  `src/processes/modules/ai/modules/opencode/opencode-host.service.ts`.
- `SessionRunnerService` / `JevService` — эталон per-user ключа
  (`OpencodeKeysService` + `CryptoService`, расшифровка в памяти) —
  `src/common/zen/session-runner.service.ts`,
  `src/common/zen/jev.service.ts`.
- `ToolRegistryService` / `ToolDispatchService` — счётчик вызовов (=0
  до LangChain-цикла, R1) — `src/processes/modules/ai/modules/tools/`.
- `createGitReconTool().view` (`native:git.recon`) — описание для модели —
  `src/processes/modules/workers/modules/tool-registry/tools/git-recon.tool.ts`.
- `ASK_FALLBACK_MODELS` — `src/processes/modules/ai/modules/agents/model-fallback.ts`
  (в стенде не используется, упомянут как существующая цепочка).

Стенд не копирует их логику: описание `git.recon` продублировано как
данные для модели (единственное место копии), исполнение — только через
`ToolDispatchService` в прод-пути, здесь — ноль вызовов.

## Запуск

```sh
# из apps/backend
bun ./draft-stand/run.ts
# или
bun run ./draft-stand/run.ts
```

Без ключа стенд честно отвечает `SKIP` на R1/R5/R6 (модель не вызывается),
R2/R3/R4 проверяются без сети.

## Ключ

Поиск только среди существующих (без гаданий):

1. `.opencode/auth.json` (cwd / корень репо),
2. `~/.config/opencode/auth.json`,
3. `~/.local/share/opencode/auth.json` (`XDG_DATA_HOME` override).

Формат — как в `apps/cli/src/agents/opencode/auth.ts`:
JSON `{opencode:{key}, opencode-go:{key}}`, приоритет
`.opencode-go.key || .opencode.key`. Значение — только в памяти
(переменная `apiKey`), никогда в логи/файлы/коммит.
В отчёте — только путь и поле (`opencode-go` / `opencode`), без значения.

## Запреты стенда

- Никаких внешних процессов/sidecar/прокси/CLI для модели.
- Никакого `LLM.loop`, никаких `sessions.create/prompt`.
- Никаких конфиг-файлов (`llm.config.json`, `opencode.json` не читается).
- Инструменты — только описание для модели (исполнения нет).
- Никаких `Bearer`/ключей/URL с секретом в файлах и логах.

## R1–R6 (кратко)

- R1: `LLM.stream` с `tools` не исполняет ни один инструмент
  (счётчик `ToolDispatchService` = 0, побочных эффектов нет).
- R2: `@opencode/ai` напрямую в `apps/backend/package.json`, точная версия
  (`2.2.5`, сейчас транзитивно через `@opencode/sdk@2.2.5`).
- R3: пара (провайдер, модель) + ключ пользователя собирается в коде,
  без `opencode.json` и без глобального env.
- R4: после прогона `git status` и файлы не меняются.
- R5: ответ даёт `tool_calls` в нашем формате, стрим и `usage` приходят.
- R6: список моделей с `tools` — из каталога OpenCode в процессе
  (`provider.list`/`model.list`), не статический список.

Если R1–R5 красные — прод-код не трогаем, `inprocess-opencode`
в цепочку не включается.
