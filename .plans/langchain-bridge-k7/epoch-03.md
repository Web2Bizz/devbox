# Epoch 3: Decision foundation — primary/фолбэк, конфликты закрыты

## Hypothesis
Из Epoch 2: три варианта LC→OC (прокси, serve Tool, CLI) и два OC→LC (custom tools → сервис, sidecar MCP). Нужно выбрать primary и зафиксировать запреты.

## Evidence Found
- File: `contracts/opencode-stand-2.2.0.json` + `contracts/opencode-upstream.json` — провенанс serve-контракта V1/V2 (существуют, сверить на пилоте с живым `/doc`).
- File: `apps/backend/src/processes/modules/ai/modules/opencode/modules/auth/serve-auth.service.ts` — `serveBasicAuthHeader` (Basic для serve; для прокси будет Bearer/ключ — разные auth, не смешивать).
- File: `apps/backend/src/processes/modules/workers/modules/model-gateway/model-gateway.stub.ts` — точка замены: `StubModelGateway` → `LangChainGateway`.
- Pattern: `ToolView {id,title,description,inputSchema,outputSchema?}` — уже OpenAI-function-совместимая проекция, маппинг в `bind_tools` прямой.
- Conflict 1 (serve как OpenAI-провайдер): serve `:4096` — свой OpenAPI, не `/v1/*`. Напрямую в `ChatOpenAI({baseURL: ...:4096})` — ЗАПРЕЩЕНО (wire не совпадёт, `tool_calls` не гарантирован).
- Conflict 2 (session state): прокси `:4010` — stateless `/v1/chat/completions` (история — в messages каждого запроса). Session state живёт в нашем журнале (`run_steps/run_events` + `session_messages`), не в прокси. Долгие run — через наш claim-loop + `tasks/get`-поллинг MCP, не удержание SSE.
- Conflict 3 (free 403): облако `openai/v1` free-модели вне OpenCode → 403. Лечится только allowlist paid/Go + fail-fast с `EXTERNAL_UNAVAILABLE + Retry-After: 30` (существующая конвенция `external-error.ts`).
- Conflict 4 (tools:false): `bind_tools` на модели без `tools:true` молча деградирует (нет `tool_calls`). Лечится гейтом `need.toolCalls → allowlist-check` до вызова.

## Decisions
- Decision: LC→OC primary — прокси `:4010` как `ChatOpenAI`-совместимый `BaseChatModel` (`/v1/chat/completions`, `/v1/models`, SSE, `tool_calls: true`) — ЕДИНСТВЕННЫЙ прод-путь. Rationale: единственный OpenAI-совместимый путь к OC-моделям; serve напрямую несовместим. При недоступности — честный 503 (`EXTERNAL_UNAVAILABLE` + `Retry-After: 30` + `x-correlation-id`), без retry внутри.
- Decision (Epoch 6, supersedes ниже): LC→OC fallback через serve Tool — ЗАПРЕЩЁН и УДАЛЁН из плана. Нет `opencode-serve.tool.ts`, нет `ToolDescriptor`-обёртки над `sessions.prompt/interrupt/messages`, нет `OpencodeHostService` в LC-пути, нет выбора primary/fallback по `need.toolCalls` + health. Rationale: запрет тихих фолбэков по backend-канону fail-fast; retry решает вызывающий. Superseded: прежняя формулировка «LC→OC fallback — serve Tool (`ToolDescriptor` …). Rationale: работает без прокси…» — отменена полностью.
- Decision: LC→OC tertiary — CLI (`opencode run`/headless) только для офлайн/дебаг, не для прод-пути. Rationale: процессный, нестриминговый, ломает журнал.
- Decision: OC→LC — custom tools `.opencode/tools/*.ts` экспонировать как LangChain-сервис (HTTP-обёртка над `execute`), не копировать логику. Rationale: reuse 22 tools, single source — скрипты `scripts/*/run.sh`.
- Decision: MCP — sidecar общий (`McpClient` URL-каталог + `MultiServerMCPClient` на стороне LC), своего MCP-сервера нет (D5). Rationale: ADR-0002 принцип «потребитель, не поставщик».
- Decision: трейсинг — LangSmith primary (`LANGSMITH_TRACING/API_KEY/PROJECT` + `langsmith-opencode` шлейф), `AppLogger + x-correlation-id` остаются обязательно. Rationale: NFR4 без замены существующей корреляции.
- Alternatives considered: (a) serve как `BaseChatModel` кастомным fetch — rejected (поддержка чужого wire вручную, хрупко); (b) отказ от прокси, только serve Tool — rejected (теряем `bind_tools` E2E, главный выигрыш LC); (c) OpenCode-ядро — rejected в Epoch 2.
- Superseded: `.plans/opencode-sdk-migration/PLAN.md` решение «только embedded SDK, внешнего раннера нет» — superseded частично: primary инференс идёт через прокси (внешний процесс в стенде); embedded host НЕ является fallback LC-пути (запрет Epoch 6). Удаление HTTP-контракта из того плана — отложено (consumers живут до конца миграции как legacy вне LC-пути, не как runtime-fallback).

## Confirmed Plan Items
1. `LangChainGateway extends ModelGateway` поверх прокси-`BaseChatModel` — reason: узкая граница; artifact: `workers/modules/model-gateway/langchain-gateway.ts`; validation: `stream()` отдаёт `delta/tool_call/done`.
2. Allowlist `tools:true` paid/Go + гейт `need.toolCalls` — reason: отсечь 403 и silent-no-tools; artifact: config + `external-error.ts` маппинг; validation: free/beelding → fail-fast до вызова.
3. Честный 503 вместо serve-Tool фолбэка (Epoch 6, supersedes): health-probe `:4010` + маппинг `EXTERNAL_UNAVAILABLE` 503 + `Retry-After: 30` + `x-correlation-id`, без retry внутри и без перехода на stub/serve. Superseded: прежний п.3 «Serve-Tool фолбэк через `OpencodeHostService` … validation: e2e без `:4010`» — отменён; e2e с остановленным прокси теперь ожидает 503, а не зелёный serve-путь. — reason: запрет тихих фолбэков; artifact: health-probe + `external-error.ts` маппинг; validation: e2e на остановленном прокси → 503.
4. Custom-tools сервис + sidecar MCP + LangSmith — reason: reuse + наблюдаемость; artifact: HTTP-обёртка, URL-каталог, env; validation: один вызов end-to-end с трейсом.

## Open Questions
- Точная версия `langchainjs` (`@langchain/core`, `@langchain/openai`, `langgraph`) под `bun 1.4.2 + zod v4` — фиксирует пилот (Epoch 4).
- Формат `ToolView.inputSchema` (JSON Schema draft?) vs `zod`/`DynamicStructuredTool` — адаптер уточнить на пилоте (Epoch 4).
- Куда положить прокси в compose/стенде (`:4010` sidecar, сеть, секреты) (Epoch 4).

## Next Epoch Focus
- Refinement: целевая архитектура по файлам/модулям, этапы с зависимостями, что отключаем/оставляем, CoC-размещение.

## Superseded (Epoch 7 — in-place, без нового модуля)

- П.1 (`workers/modules/model-gateway/langchain-gateway.ts`, `LangChainGateway extends ModelGateway`) — ОТМЕНЁН Epoch 7: нового gateway-файла нет, LC step-executor — внутри `SessionHarnessService`, шаг отдаётся в существующий `SessionTurnRunnerService.runTurn` как `StepExecutor`.
- `MODEL_GATEWAY`-формулировки (включая «единственный `MODEL_GATEWAY=langchain`») — ОТМЕНЕНЫ Epoch 7: переключатель не вводится вообще.
- Актуальное состояние — см. `PLAN.md` (in-place) и `epoch-07.md`.

## Terminology (Epoch 8 — глоссарий session/harness/runner; историю не переписывает)

- Читать этот эпох по `PLAN.md §0` (`epoch-08.md`): `session` — только чат, `harness` — только система (`SessionHarnessService`), `runner` — только экземпляр цикла (`SessionTurnRunnerService` + `loop/max-steps/retry`); `freeze/stop/kill/run` — только определение управления runner, не скоуп. Кодовые имена без переименования.

## Config-isolation (Epoch 9 — harness игнорирует opencode-конфиги; историю не переписывает)

- Читать этот эпох с инвариантом `epoch-09.md` (норматив — `PLAN.md` шапка + §§1/5): новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель: `.opencode/opencode.json`; иные — `[???]`, список не зафиксирован) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути (решение Epoch 9, поведение ранее не задано). LangChain-ядро / `:4010` / 503 / in-place / запреты Epoch 6–7 и глоссарий Epoch 8 — без изменений.
