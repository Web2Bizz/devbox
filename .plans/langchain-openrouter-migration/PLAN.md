# План: единый OpenAI-совместимый слой моделей в rush-code (OpenCode как один из провайдеров)

Статус: верхний документ по LLM-слою агентской системы backend. Заменяет langchain-backend-rebuild и langchain-openrouter-unified (в части LLM-слоя). Базовая карта этапов и инварианты — langchain-bridge-k7 (Э0–Э4), база коммита 0300575, ветка feat/chat-commit-cur, Forward-Only.

## 0. Целевое состояние (north star)

Провайдер моделей добавляется кодом (класс провайдера в TypeScript, реализующий общий интерфейс). После этого агентская система LangChain работает с ним так же, как с OpenRouter или любым другим OpenAI-совместимым провайдером. Конфигурационных файлов для провайдеров и цепочек нет: всё задаётся кодом.

- OpenCode — один из провайдеров. Он выглядит для системы как OpenAI-совместимый endpoint: `chat/completions` с `messages`, `tools`, `tool_calls`, стримом и `usage`.
- Внутри процесса это достигается in-process адаптером (`fetch`-обёртка для `ChatOpenAI`), без внешнего сервиса и без порта.
- Система сама выбирает модель из цепочки по доступности, capability (`tools`) и квотам. Пользователь выбирает только режим `auto | ask`.
- Провайдеры взаимозаменяемы: агенты не меняются, провайдер подключается реализацией в коде.

Что НЕ входит в целевое состояние:
- OpenCode как исполнитель инструментов, файлов, shell, git или кода. Он только модель.
- Внешние процессы, sidecar, CLI в прод-пути.

## 1. Жёсткие правила

1. Инструменты (tools) существуют только как LangChain tools (`tool()` / `DynamicStructuredTool` из `langchain` / `@langchain/core`) и никак иначе. Прямые вызовы инструментов, самописные обёртки вне LangChain, инструменты провайдера и инструменты, исполняемые вне LangChain-цикла, запрещены. Источник реализаций — только rush-code: `ToolRegistryService`, `ToolDispatchService`, `.opencode/tools` через bootstrap, MCP-клиент проекта, субагенты проекта. Исполнение — через `ToolDispatchService`, который вызывается из функции LangChain-инструмента.
2. Провайдер моделей — только источник ответа модели. Он не исполняет инструменты, не пишет код, не меняет файлы, не запускает shell/git.
3. Встроенные инструменты OpenCode запрещены на любом пути (проверяется спайком и тестами).
4. Внешние вызовы вне харнеса для инструментов, MCP, классификации и т.п. запрещены. Внешний OpenAI-совместимый endpoint модели разрешён только как провайдер модели, реализованный в коде (см. §11, открытый вопрос Q1).
5. Внешний sidecar, внешний прокси и внешний CLI как обход — запрещены.

## 2. Абстракция «провайдер моделей»

Единый контракт: провайдер = TypeScript-класс, реализующий общий интерфейс `ModelProvider`. Интерфейс описывает поля:

- `id` — константа в коде (например `opencode`, `openrouter`).
- `transport`: `inprocess-opencode` (вызов модели через `@opencode/ai`, без агента, для OpenCode) или `http-openai` (стандартный `baseURL` + ключ, для OpenRouter и подобных).
- `models[]` — модели с признаками: `tools`, `jsonSchema`, `zdr` (если применимо), приоритет.

Клиент для агентов всегда один: `ChatOpenAI` из `@langchain/openai`. Различается только `configuration.fetch` (in-process для OpenCode) или `baseURL` (HTTP для остальных). Агенты не знают провайдера.

Ключи провайдеров — только per-user, через УЖЕ РЕАЛИЗОВАННЫЙ механизм, ничего нового не создаём:
- Хранение: существующий `OpencodeKeysService` (`apps/backend/src/common/keys/opencode-keys.service.ts`, таблица `user_opencode_keys`) переименовывается в `UserKeysService` и получает измерение провайдера: одна строка на пару (userId, provider), только ciphertext (`encryptedKey`, `iv`, `keyId` — версия KEK). Переименование — отдельной карточкой (C1a), с миграцией схемы и обновлением `keys:reencrypt`.
- Шифрование: `CryptoService` (расшифровка в памяти на время вызова). Plaintext никогда не пишется в БД и не логируется.
- Ротация: существующий скрипт `bun run keys:reencrypt`.
- Ошибки хранилища: существующий путь `dbUnavailable` → 503 `EXTERNAL_UNAVAILABLE` + `Retry-After: 30`.
- Эталон использования: `common/zen/session-runner.service.ts` и `common/zen/jev.service.ts` уже берут ключ вызывающего через `OpencodeKeysService`. Новый провайдер подключается тем же способом, без своего хранилища.
- Ключей в `.env`, в репо и в env сервера нет. Константы провайдеров (`baseURL`, имена моделей, признаки) — в коде провайдера; `.env` содержит только не-секретные параметры, если они нужны.
- Фолбэков на чужой или серверный ключ нет (AGENTS.md backend: фолбэки запрещены по умолчанию; env — строгая валидация).

## 3. Транспорт OpenCode: вызов модели без агента (решение, S0 — доказан стендом)

Черновик-доказательство (внедряем отсюда): `apps/backend/draft-stand/` — `code-agent.ts` (реализация `runCodeAgent`), `code-agent.verify.ts` (прогон R1–R6), `code-agent.README.md` (пример), `run.ts` + `assertions.ts` (база S0). Прогон `bun ./draft-stand/code-agent.verify.ts` (cwd `apps/backend`) — GREEN, exit 0: `model-called PASS text_len=2`, `R1/R2/R4 PASS`, `secret-scan PASS`.

Выбранный путь (уточнён стендом): OpenCode используется только как провайдер модели через Effect-рантайм `@opencode/ai` (`make()`), а не через несуществующий `LLM`-экспорт (в пине `2.2.5` `LLM` — только тип, в рантайме только `make/ai/tool`; `LLM.loop` не используем тем более).
- `make()` из `@opencode/ai` + `openai-compatible`-роут (`baseURL https://opencode.ai/inference/openai/v1`, `provider:'opencode'`, per-call `apiKey` пользователя) выполняют ровно один вызов модели (`client.generate({model, system, prompt, tools:[]})`). Инструменты не исполняются (стенд: `dispatchCalls=0`, `ToolDispatchService` не импортируется).
- `LLM.loop`, сессии и цикл OpenCode (`sessions.create`, `sessions.prompt`) в пути НЕ участвуют. Поэтому OpenCode не может писать файлы: у него нет исполнения.
- Ключ пользователя передаётся провайдеру при создании модели на вызов (`apiKey`), без глобального env и без `opencode.json`.
- Эквивалентность с OpenRouter: тот же механизм «модель отдаёт tool_call, мы исполняем через ToolDispatchService».

Требования S0 (доказаны стендом `code-agent.verify.ts`, GREEN):
- R1. Вызов модели с `tools:[]` не исполняет ни один инструмент (стенд: `dispatchCalls=0`, `ToolDispatchService` не импортируется).
- R2. Пакет `@opencode/ai` подключён к `apps/backend/package.json` напрямую, с точной версией (сейчас транзитивно через `@opencode/sdk`). Смена версии — только с прогоном S0.
- R3. Из пары (провайдер, модель) и ключа пользователя собирается `LanguageModel` в нашем коде, без `opencode.json` и без глобального env.
- R4. После прогона `git status` и содержимое файлов не меняются.
- R5. Ответ модели даёт текст/код + `usage` (`text_len=2`, `usage=52/3/55` в стенде); `tool_calls`-путь подключается на C2 поверх того же транспорта.
- R6. Список моделей с поддержкой tools берётся из OpenCode-каталога внутри процесса (`provider.list`/`model.list`), не из статического списка в коде (стенд: `catalog=yes toolsCapable=76`).

Статус S0: GREEN (стенд `apps/backend/draft-stand/code-agent.verify.ts`, exit 0). Внедряем прод-адаптер с `code-agent.ts` как базы: `runCodeAgent` → `ModelProvider inprocess-opencode`. Если R1–R5 регрессируют при переносе, провайдер не включается в цепочку.

Если R1–R5 не проходят, провайдер `inprocess-opencode` не включается в цепочку. Остальные провайдеры работают, отказ цепочки — 503 `EXTERNAL_UNAVAILABLE` + `Retry-After: 30`. Патч SDK (вариант vendored) — только по отдельному решению с ADR.

Прежние варианты «агент только для чтения» и «обнаружение PROVIDER_TOOL_LEAK с interrupt» снимаются: при вызове `LLM.stream` исполнения нет, поэтому обнаруживать и откатывать нечего.

## 4. Архитектура

- **Адаптер провайдера.** Для OpenCode — база `apps/backend/draft-stand/code-agent.ts` (`make()` + `openai-compatible`-роут, без агента и без `loop`), переносимая в прод рядом с `OpencodeHostService`; `tool_calls`-маппинг и SSE — на C2 поверх того же транспорта. Для остальных провайдеров — стандартный `baseURL`. Адаптер живёт рядом с `OpencodeHostService`, без нового домена и без HTTP-клиента к серверу OpenCode.
- **Step-executor** в `SessionHarnessService`: `ChatOpenAI` выбранного провайдера → `bind_tools(ToolView[])` → шаг в `SessionTurnRunnerService.runTurn`. `maxRetries: 0`, ретраи через router.
- **Router/fallback** в `agents/model-fallback.ts`. Цепочка задаётся в коде, фильтр по `tools:true`, health, квотам. Автоматическое переключение между провайдерами разрешено (Q5). Классы ошибок: retriable (429/5xx/таймаут) → 1 retry → следующий; switch (404 модели) → следующий; fatal (400/422) → стоп; auth (401/403) → fail-fast; bad_tool_call → следующий; `PROVIDER_TOOL_LEAK` → провайдер исключается из цепочки для запроса.
- **Инструменты (только LangChain):** каждый инструмент — `DynamicStructuredTool` (или `tool()`) с zod-схемой, сформированный из `ToolView` в `tools.bootstrap.ts`. Его `func` вызывает `ToolDispatchService.dispatch` без изменения логики. Только этот набор LangChain-инструментов передаётся в `bind_tools`. Субагент — LangChain tool поверх `subagent-job.service.ts`. MCP — LangChain tools, построенные поверх `mcp-client.ts`. Вне LangChain инструменты не вызываются и не регистрируются.
- **503:** только когда цепочка исчерпана или пуста. `EXTERNAL_UNAVAILABLE` + `Retry-After: 30` + `x-correlation-id` через `external-error.ts`. Тихих фолбэков нет.
- **Журнал и идемпотентность (фактор обязательный):** `run_steps` / `run_events` через `session-history.repository.ts` — единственная истина. Действуют правила I1–I7 (см. §4.1). Resume не переисполняет закоммиченные LLM-шаги и мутации ни при каких условиях: ни наш router, ни LangGraph (если используется) не вправе повторно исполнить эффект с тем же ключом.
- **Режимы:** `auto` — инструменты rush-code исполняются, мутации разрешены. `ask` — строго только чтение: мутирующие инструменты не исполняются и не создают intent, модель получает отказ от инструмента с понятным текстом.
- **Наблюдаемость:** `AppLogger` + `x-correlation-id`, `relaySse` без изменения протокола. Audit на попытку: провайдер, модель, attempt, outcome, reason, latency.
- **Config-isolation (Epoch 9):** harness не читает `opencode.json` и иные opencode-конфиги. Настройки провайдеров — в коде; env — только не-секретные параметры, если нужны.

### 4.1. Идемпотентность цепочки (I1–I7, обязательно)

Основание: официальная документация LangGraph JS (`checkpointers`, `interrupts`). LangGraph resume (`invoke(null)` / `Command({resume})` с тем же `thread_id`) не переисполняет успешные ноды super-step, но: replay с `checkpoint_id` переисполняет ноды после чекпоинта; нода с `interrupt()` при resume стартует с начала; краш до первого durable-чекпоинта = вызов как будто не было. Поэтому внешнюю мутацию от повтора защищает только наш журнал, а не сам LangGraph.

- I1. Ключ эффекта: `runId + stepSeq + toolCallId`. `run_steps UNIQUE(runId, seq)`, `run_effects intent → committed`. Повторный вызов с тем же ключом — отказ без исполнения (дедупликация на уровне `ToolDispatchService`).
- I2. Переключение модели/провайдера — только до `dispatch` инструмента. Частичный стрим после `tool_call` без записи шага отбрасывается, модель переспрашивается с тем же контекстом.
- I3. Resume берёт последний `committed` шаг. Закоммиченные LLM-шаги и эффекты не переисполняются ни router'ом, ни LangGraph-графом.
- I4. Если LangGraph используется: только custom checkpointer поверх `run_steps/run_events` (`thread_id ↔ runId`, интерфейс `BaseCheckpointSaver`: `put / putWrites / getTuple / list`). Отдельные таблицы `PostgresSaver` не создаём. `MemorySaver` — только dev/тесты.
- I5. `interrupt/confirm` — только для `auto`. `ask` — строго чтение, без intent и без `interrupt`.
- I6. Мутация исполняется ровно один раз: проверка ключа до исполнения + запись `committed` после. Рестарт mid-run → пропуск закоммиченного без повтора `tool.call` / `git.commit`.
- I7. Аудит каждой попытки содержит ключ эффекта, провайдера, модель, outcome и reason — для сверки дублей.

## 5. Запреты (k7 + добавленные)

- Новый доменный модуль `workers/modules/langchain/`, `lc-tools.adapter.ts`, `lc-tracing.setup.ts` — не создаём. Никаких новых конфигурационных файлов (включая `llm.config.json`) не создаём. Новые файлы — только код провайдеров и router внутри существующих доменов (`agents/model-fallback.ts`; отдельный файл только отдельным решением).
- `MODEL_GATEWAY=stub|langchain` и stub как runtime-fallback — запрещены.
- serve-Tool как fallback (`opencode-serve.tool.ts`) — запрещён.
- Sidecar, внешний прокси, внешний CLI как обход — запрещены.
- Встроенные инструменты OpenCode — запрещены на любом пути.
- Инструменты вне LangChain (прямой вызов `ToolDispatchService` из агента, самописный реестр инструментов, инструменты провайдера, вызов через shell/fetch в обход LangChain tool) — запрещены.
- Free, jev, image, embedding модели — вне цепочки.
- Ключи провайдеров в `.env`, в коде, в env сервера и в репо — запрещены. Ключи только per-user.
- Любые конфигурационные файлы провайдеров и цепочек (включая `llm.config.json`) — запрещены. Провайдеры реализуются кодом.
- Повторное исполнение закоммиченного эффекта (тот же `runId + stepSeq + toolCallId`) — запрещено на любом пути (I1–I3, I6).

## 6. Этапы и карточки

- **Э0 Характеризация и спайк**
  - C0: характеризация `ASK_FALLBACK_MODELS` (fail-fast на ключе), SSE `done` / `stream.error` / `Retry-After`. Существующие тесты зелёные до изменений.
  - S0: спайк R1–R6 для OpenCode — DONE GREEN стендом `apps/backend/draft-stand/code-agent.verify.ts` (база внедрения: `code-agent.ts`). Без S0 прод-код не пишем (выполнено).
- **Э1 Провайдеры (внедрение черновика)**
  - C1: интерфейс `ModelProvider` в коде (`transport`, `baseURL`, список моделей с признаками `tools`, `jsonSchema`), реестр провайдеров и цепочка — константы в коде, валидация типами и zod на границе. Ключ берётся через существующий `OpencodeKeysService` + `CryptoService` вызывающего пользователя; новое хранилище не создаём. Нет ключа у пользователя → понятная ошибка, без фолбэка. Новых конфиг-файлов нет. Blocked by: C0.
  - C1a: переименование `OpencodeKeysService` → `UserKeysService`, отдельный модуль, ключ по паре (userId, provider), миграция схемы, обновление `keys:reencrypt`. Blocked by: C0.
  - C2: адаптер `inprocess-opencode` — внедрить `code-agent.ts` из стенда в прод (рядом с `OpencodeHostService`): `make()` + `openai-compatible`-роут, per-call `apiKey`, `tools:[]` → далее `tool_call`-маппинг и SSE; прямая зависимость `@opencode/ai` с точной версией уже добавлена стендом. Blocked by: S0, C1, C1a.
  - C2b: адаптер `http-openai` (стандартный `ChatOpenAI` с `baseURL`). Blocked by: C1.
  - C4: router/fallback по цепочке и классам ошибок. Blocked by: C2, C2b.
- **Э2 Инструменты**
  - C3: `ToolView → DynamicStructuredTool` (только LangChain), субагент как LangChain tool, MCP через LangChain tools поверх `mcp-client.ts`; запрет прямых вызовов `ToolDispatchService` вне LangChain tool. Blocked by: C2.
- **Э3 Честный 503 и режимы**
  - C9: probe провайдеров на send-пути; 503 только при исчерпании. Blocked by: C4.
  - C5: замена цикла фолбэка в пяти агентах на router. Blocked by: C4.
  - C6: режимы auto/ask: `ask` — только чтение (мутирующие инструменты отключены на уровне `bind_tools` и повторно проверяются в `ToolDispatchService`); `auto` — мутации разрешены. Признак мутации у инструмента. Blocked by: C3, C5.
- **Э4 Харденинг и приёмка**
  - C7: идемпотентность и resume (I1–I7): ключ эффекта, дедупликация в `ToolDispatchService`, отбрасывание частичного стрима, resume с последнего `committed`, custom checkpointer (если LangGraph) поверх `run_steps`. Blocked by: C6.
  - C8: audit на попытку, `done` аддитивно (`model`, `provider`, `fallback`), скан секретов. Blocked by: C5.
  - C10: `bun run lint/build/test/test:e2e`; resume без дублей (I3, I6 зелёные); ask без confirm не исполняет мутацию; 503 только при исчерпании; R4 зелёный; добавление нового провайдера — только новая реализация `ModelProvider` и регистрация в коде. Blocked by: C6, C7, C8.

Порядок: Э0 → Э1 → Э2 → Э3 → Э4. Зависимые карточки внутри этапа не параллелить.

## 7. Критерий приёмки целевого состояния

- Добавление третьего OpenAI-совместимого провайдера выполняется новой реализацией `ModelProvider` и регистрацией в коде, без правки агентов и router.
- OpenCode-модель, вставленная в конфиг, отвечает на запрос агента как OpenRouter-модель: тот же `bind_tools`, тот же формат `tool_calls`, тот же стрим и `usage`.
- Агент получает `tool_calls` и исполняет их только через `ToolDispatchService`. Ни один инструмент не исполняется провайдером.
- При недоступности одного провайдера цепочка переключается на следующего; при исчерпании — 503 + `Retry-After: 30`.
- Идемпотентность: повторный вызов с тем же `runId + stepSeq + toolCallId` не исполняется (дедупликация); restart mid-run не даёт повтора `tool.call` / `git.commit`; resume продолжает с последнего `committed`.

## 8. Тесты (обязательные)

- Изоляция (R1, R4): запрос с `tools` к `inprocess-opencode` не исполняет ни одного инструмента (счётчик вызовов `ToolDispatchService` = 0 до LangChain-цикла); нет изменений в ФС и `git status`.
- Взаимозаменяемость: один и тот же сценарий `bind_tools([git.recon])` проходит для `inprocess-opencode` и `http-openai` без изменений в агентах.
- Адаптеры: OpenAI-запрос с `tools` → `tool_calls` в OpenAI-формате; SSE-кадры; битые аргументы → bad_tool_call → следующий кандидат.
- Router: недоступна модель → следующая; 429 → retry и переключение; 400 → без переключения; все исчерпаны → 503 + `Retry-After: 30` + `x-correlation-id`.
- Инструменты rush-code: `git.recon` + 1 custom + 1 MCP через цикл end-to-end. Проверка, что каждый вызов прошёл через LangChain tool (трасса вызова содержит LangChain tool call id), и что прямых вызовов `ToolDispatchService` из агентов нет (grep/лint-правило на проекте).
- Журнал: restart mid-run → нет повтора `tool.call` и `git.commit` (I3, I6).
- Дедупликация: повторный `dispatch` с тем же ключом эффекта → отказ без исполнения; audit содержит оба вызова с одним ключом.
- Переключение модели mid-step до `dispatch` → эффект исполнен ровно один раз новым кандидатом.
- Режимы: в `ask` мутирующий инструмент не исполняется ни при каких условиях и не создаёт intent; в `auto` мутация исполняется ровно один раз.
- OpenCode-агент с переопределёнными правами: запись в файлы и исполнение shell/git отклоняются провайдером (проверяется в S0 и в тесте R4).
- Секреты: скан логов, артефактов, `.env*`, конфигов и репо на Bearer, ключи, URL. Тест: в `.env*` и в коде провайдеров нет ни одного ключа; ключ пользователя A не виден и не используется для запроса пользователя B.
- Per-user ключи: запрос без ключа пользователя → понятная ошибка, без фолбэка на чужой или серверный ключ.

## 9. Complexity и риск

- complexity: score 18, level high, файлов ~16, карточек 11 (C0–C10 + C2b), type decompose, deps: `@langchain/core`, `@langchain/openai`. `langgraph` не обязателен.
- risk: high, 7/8, факторы breaking, data, security, external.
- Главный риск: зафиксировать поведение `@opencode/ai` в пине (R1 в §3). Стенд доказал `make().generate` с `tools:[]` (dispatch=0); регресс при переносе закрывает провайдер. Митигация: S0-тест и пин версии (`@opencode/ai 2.2.5` уже в `package.json`).
- Риск API: `@opencode/ai` — внутренний слой; смена версии может сломать адаптер. Митигация: прямой пин и S0 при каждом обновлении.
- Патч SDK — только по отдельному решению с ADR.

## 10. Контракт API/SSE (аддитивно)

- `done`: опционально `model`, `provider`, `fallback{attempts, switchedFrom?, reason?}`.
- `tool.call` / `tool.result`: опционально `toolCallId`, `agentId`.
- Запрос: опционально `mode: auto | ask` (без поля — `auto`). Выбора модели и провайдера в API нет.
- `contracts/openapi.yaml` и `packages/contracts` — зеркало, только optional. Новых эндпоинтов нет.

## 11. Открытые вопросы

Ответы владельца (зафиксированы):

1. Q1 — ПРИНЯТО. OpenCode и OpenRouter — только провайдеры моделей, инструменты остаются у rush-code.
2. Q2 — ПРИНЯТО (уточнено). Агент OpenCode переопределяется: только чтение и генерация ответа без записи в файлы. Это ограничение задаётся на стороне провайдера (права агента), а не доверием к модели. S0 обязан доказать R1–R4 с этим переопределением. Вариант (b) — патч SDK — не выбран, остаётся только при провале S0 и отдельном решении.
3. Q3 — ПРИНЯТО (с переделкой). Ключи только per-user. `OpencodeKeysService` переименовывается в `UserKeysService` и выносится в свой модуль (`common/keys`). Таблица хранит ключи по каждому провайдеру: ключ = (userId, provider), а не один ключ на пользователя. Миграция схемы и `keys:reencrypt` учитывают поле `provider`. Фоновые run — ключ владельца run (инициатор), подтверждение ещё нужно.
4. Q4 — ПРИНЯТО (строже). Режим `ask` — только чтение: никаких мутаций вообще, ни с confirm, ни без. Режим `auto` — мутации разрешены инструментами rush-code. Вариант «ask с подтверждением» из плана снят.
5. Q5 — ПРИНЯТО. Автоматическое переключение между провайдерами разрешено цепочкой в коде.
6. Q6 — ПРИНЯТО УСЛОВНО (по официальной документации LangGraph JS: `checkpointers`, `interrupts`). Resume без повтора успешных нод — да, но только для незавершённого (`invoke(null)` / `Command({resume})`); replay и нода с `interrupt()` переисполняют код, краш до durable-чекпоинта теряется. Поэтому: LangGraph — только с custom checkpointer поверх `run_steps/run_events` (I4), истина — наш журнал; внешнюю мутацию защищает только I1–I3, I6, а не сам LangGraph. `interrupt/confirm` — только для `auto` (I5). Проверка сигнатур `BaseCheckpointSaver` и `durability` — по исходникам пина на C0.
7. Q7 — ПРИНЯТО. Конфиг-файлов нет, провайдеры и цепочка — код.

## 12. Не проверено (проверяется на S0 и C0 внутри репо)

- Поведение `make().generate` в зафиксированной версии `2.2.5` — доказано стендом (`model-called PASS`); при обновлении пина — заново прогонять `code-agent.verify.ts`.
- Сборка модели с per-call `apiKey` для OpenCode-провайдера — доказана стендом (ключ из `auth.json` в памяти, `key_len` в логе).
- Имена API `@langchain/openai` в пине и поведение `configuration.fetch`.
- Возможности LangGraph для восстановления цепочки (Q6): по документации подтверждено (условно, см. §4.1, §11 Q6); по исходникам пина на C0 проверить сигнатуры `BaseCheckpointSaver`, `durability`, `thread_id`, семантику `invoke(null)` vs `Command` vs replay.
- Стрим OpenCode (`events.subscribe`, live-only, без replay): как покрыть redial без дублей.
