# План: сложная мультиагентная система с ветвлениями (iron-branch-v1)

Ветка: `feat/cli-cloud-chat`. Глубина: high (эпохи 0–5). Код не пишется — план к обсуждению.

## Матрица покрытия 7 требований пользователя (где что живёт)
| # | Требование | Где в плане | Коротко |
|---|---|---|---|
| 1 | Циклы и классификаторы | epoch-01 Addendum (condition-узлы, classifier-node, иерархия ≤2, snapshot/version) + epoch-03 §п.1+Addendum (назад-рёбра с maxRetries) | Jev = переиспользуемый `classifier-node`, а не только STEP 0 Auto (`auto.agent.ts:60`); доменный → уточняющий; назад-ребро без `maxRetries` → reject валидатором |
| 2 | MCP + skills + tools | **epoch-04** (+ Addendum 2026-11-04) + epoch-00 §§1–3 | 3 слоя за одним контрактом: native / skills (hot-reload вотчер chokidar, `имя@версия/sha`, fallback boot-лоад) / MCP **только Streamable HTTP** (`tools/list`+`tools/call` через ExternalClient, `MCP_ALLOWED_HOSTS`, stdio-spawn запрещён); единый `ToolRegistry` + allowlist на `{graph_id, mode}` |
| 3 | Расширяемость/масштабируемость | epoch-01 Addendum (код+конфиг+zod, snapshot, `graph_id` auto-v2→v3) + **epoch-05** §§Decision/п.1–2 | Stateless runner + Postgres — единственное состояние; 2 реплики OK (advisory lock / SKIP LOCKED); версионирование графов |
| 4 | Фоновые воркеры | **epoch-05** §§Decision/п.1,п.3 (пересмотр epoch-02 «в процессе») | `GraphRunner` в `GraphWorker` (`processes/modules/workers/` — сейчас scaffold `@Module({})`), pg-очередь SKIP LOCKED (выбрана vs BullMQ: ноль новых зависимостей, Postgres уже обязателен); POST → `201 {runId}` сразу, фронт на SSE по runId; cancel через AbortSignal (связка с `interrupt`) |
| 5 | Журналирование событий | epoch-03 §п.4 + **epoch-05** §§Decision/п.2,п.6 + Addendum 2026-11-04 (event-driven §A, git-журнал §B) | `agent_runs/agent_steps` append-only (write-ahead ДО исполнения, outbox следующего события) + очередь = транспорт, журнал = правда; resume = перечитать журнал + доисполнить; git project repo — второй журнал (коммиты `agent/<runId>`, формат `chore(agent): <node_id> <summary>` + трейлеры `Run/Node/Attempt`, только revert-вперёд, никогда reset--hard/push--force) |
| 6 | Стрим стейта на фронт | PLAN.md §состояние графа + epoch-01 §п.5, epoch-02 §п.5, epoch-03 §п.4–5 + **epoch-05** §п.4–5 | SSE-кадры `graph.node.*` / `graph.edge.taken` / `graph.branch.*` / `graph.join.done` / `graph.approve.required|resolved` поверх `relaySse/toStreamFrame` (аддитивно, `data.sessionID` обязателен); подписка `GET .../:id/stream` + `GraphTrace/ApproveCard`; старые клиенты игнорируют |
| 7 | Min vendor lock | **epoch-04** §§Decision/п.4–6 | Ports&Adapters: `InferencePort {chat, chatStream}` (адаптеры Zen/OpenAI-compat/Anthropic/Vercel-AI-SDK), домен зависит только от порта; Jev — заменяемый `ClassifierPort`; env strict без тихих фолбэков; матрица смены провайдера ниже |

## Матрица «что меняется при смене провайдера инференсов» (требование 7)
| Меняется (1 файл + env) | НЕ меняется |
|---|---|
| Новый `*-inference.adapter.ts` за `InferencePort` + env `INFERENCE_PROVIDER/BASE_URL/MODEL/KEY` (strict enum, невалиден → fail-fast на boot; в рантайме — EXTERNAL_* как сейчас) | Доменные агенты, граф-определения (`auto-v2`…), `ToolRegistry`, `BudgetPolicy`, `agent_runs/steps`, SSE-кадры, фронт, approve/jail/гейты |
| `tool_calls`-нормализация внутри адаптера (формат различается по провайдерам — ответ на Open Question эпохи 0) | `GraphRunner`, воркер, журнал, контракты |

## Откуда идём (факты)
- `SessionRunnerService` (`apps/backend/src/common/zen/session-runner.service.ts`): прямой OpenAI-compatible POST на ZEN_CHAT_URL, per-user ключ (OpencodeKeysService+CryptoService), stream:true + fallback plain POST, model guard (quota saver), AppLogger, EXTERNAL_* envelope. Параметра tools НЕТ.
- Агенты (`apps/backend/src/processes/modules/ai/modules/agents/`): ask (один ответ), auto (Jev-классификатор → линейная цепочка decompose→≤5 шагов→synthesize через Backend|Frontend|FullstackAgent). Все — только текстовые промпты, инструментов нет.
- `JevService` — платный SystemOne choice-роутер (каждый Auto-запрос = +1 billed call).
- История в Postgres (`project_sessions`/`session_messages`/`session_agents`, `common/db/schema.ts` + `session-history.repository.ts`); в памяти harness-а — `busyDirect`/`localFrames` (теряются при рестарте).
- SSE (`session-harness.service.ts` + `common/sse/sse-relay`): кадры `message.part.delta|updated`, `session.idle`, фильтр по `data.sessionID`, `toStreamFrame` {id,type,data}+hoisted session. Фронт: Ask/Auto режимы, shimmer, sending гасится только по `session.idle`.

## Выбор движка графа: свой минимальный (рекомендуется)
| Критерий | Свой (~200 строк, NestJS DI + Drizzle + zod) | LangGraph | Vercel AI SDK |
|---|---|---|---|
| Per-user ключи + lazy re-encrypt | native, текущий код untouched | свой key-loader ломается о их рантайм | то же |
| EXTERNAL_* envelope + ApiErrorFilter + x-correlation-id | сохраняется 1:1 | их ошибки надо маппить | их ошибки надо маппить |
| AppLogger-каноны (однострочники, без секретов, стек только в debug) | сохраняется | их внутренние логи мимо канона | их внутренние логи мимо канона |
| Model-fallback (ASK_FALLBACK_MODELS) + model guard | переиспользуется | дублировать | дублировать |
| Jev-биллинг (платный classify) | считается в BudgetPolicy | снаружи, вручную | снаружи, вручную |
| Checkpoint в НАШ Postgres (Drizzle-миграции, soft-delete, RESTRICT) | native таблицы runs/steps | их checkpointer (sqlite/postgres) — вторая правда | нет checkpoint |
| SSE-кадры под наш фронт (sessionID-фильтр, idle-семантика) | native расширение | адаптер | их стриминг ≠ наш контракт |
| Зависимости | ноль | @langchain/langgraph + змейник версий | ai + провайдеры |
| Риск | писать самим (малый объём) | версионный дрейф, чужой цикл | привязка к их API |

Вывод: свой движок — полный контроль, ноль зависимостей, вписывается в NestJS DI + Drizzle + существующие каноны. LangGraph рассмотреть только если позже понадобятся распределённые супервизоры; Vercel AI SDK — только как стриминг-хелпер фронта, не как оркестратор.

## Состояние графа (где хранить, рестарт, стрим)
- Таблицы (Drizzle, `drizzle/`-миграция, soft-delete правило как у истории): `agent_runs {id uuidv7, session_id text, project_id uuid→projects RESTRICT, graph_id, status running|waiting_approve|done|failed, input/output jsonb (+usage, +graph snapshot), approve_expires_at, created/updated/deleted_at}` + `agent_steps {id uuidv7, run_id→runs CASCADE, branch_id nullable, node_id, kind, status, input/output/error jsonb, attempt, started/ended_at}` + индекс `(run_id, node_id)`.
- Продолжение после рестарта: при boot (или по запросу) `SELECT steps WHERE run_id AND status NOT IN (done)` → runner доисполняет с идемпотентностью `(run_id,node_id,attempt)+dedupeKey` (эпоха 2) — платные вызовы не повторяются. In-memory `busyDirect/localFrames` больше не источник правды для графа.
- Стрим во фронт: существующий `relaySse` + `toStreamFrame` неизменны; новые типы кадров аддитивно: `graph.node.started|done|failed`, `graph.edge.taken`, `graph.branch.started`, `graph.join.done`, `graph.approve.required|resolved`. Обязательное поле `data.sessionID` (иначе фильтр дропнет). Старый фронт игнорирует неизвестные type (контракт не ломается); новый рисует trace/ветки/approve-карточку. Контракт фиксируется в `contracts/openapi.yaml` + `@rush-code/contracts`.

## Безопасность (сквозная)
- Jail: все файловые tools — только через `WorkspacePathService` поверх `REPOS_ROOT` (без корня — 503, не cwd); путь вне джейла → 403 до вызова.
- Гейты: C4 `assertProjectAccessById` на каждом новом эндпоинте; JwtAuthGuard; zod на входе.
- Approve-точки: `sideEffect=write|external` требует `requiresApprove=true` и `ctx.approved`; без approve handler не вызывается. Read-инструменты идут без блокировки.
- Лимиты: fan-out cap (default 3), maxStepsPerRun (15), maxToolIters (3), maxRetries на назад-рёбрах (обязателен), TTL approve (10 мин), STREAM_CAP/LOCAL_IDLE_MS уже есть в harness.
- Идемпотентность: `(run_id, node_id, attempt)` + хэш input; ретрай/рестарт не дублирует платные вызовы.
- Логи: без тел/ключей/URL; e2e-скан секретов на новые пути (эталон `keys.e2e.ts`).

## Эпохи (кратко)
- **Эпоха 0 — контракт инструментов + реестр/allowlist.** `AgentTool` тип (zod in/out, sideEffect, requiresApprove), `ToolRegistry`, 3 read-инструмента (files_list, history_search, jev_classify), аддитивный `tools?` в `runner.chat`, zod-схемы в contracts. Готовность: инструмент вызывается из юнит-теста через реестр с jail-чеком; ответ без tool_calls идёт старым путём. Риск: формат tool_calls от ZEN_CHAT_URL неизвестен → проверить system-промптом до кодирования (нормализация переехала в адаптеры эпохи 4).
- **Эпоха 1 — граф-оркестратор.** `GraphDefinition` (узлы agent|tool|condition|merge|approve, рёбра when|default) + zod-валидатор, `GraphRunner` с персистентностью после каждого узла (agent_runs/agent_steps), первый граф `auto-v2` 1:1 со старым Auto (регресс зелёный), SSE-кадры node/edge. Готовность: kill-backend-mid-run → resume даёт тот же output. Риск: scope-ползучесть DSL условий → только кодовые предикаты в v1. Addendum 2026-11-04: condition-узлы здесь, classifier-node (Jev переиспользуемый) + иерархия ≤2, snapshot/version (детали — эпоха 5).
- **Эпоха 2 — параллелизм + бюджеты.** Узлы fanout/join (стратегии all|any-first|synthesize), `BudgetPolicy` (fan-out cap, maxSteps, cost units), `Promise.allSettled` веток, идемпотентность dedupeKey, SSE branch/join кадры. Готовность: fullstack-кейс (backend+frontend параллельно → синтез) + юнит «fanout 10 при cap 3 → отказ до вызовов». Риск: AbortSignal-гашение проигравших веток; кросс-инстанс гонки (advisory lock — опционально). Примечание 2026-11-04: исполнение «в процессе» пересмотрено эпохой 5 (фон-воркер), семантика fanout/join без изменений.
- **Эпоха 3 — циклы/ретраи + human-approve + наблюдаемость.** Назад-рёбра с обязательным maxRetries, узел approve (waiting_approve + TTL + `POST .../approve`), jail/гейты сквозные, `GET .../steps` trace + SSE-документация в contracts + AppLogger-сводки, фронт `GraphTrace.tsx`/`ApproveCard.tsx` аддитивно. Готовность: e2e «write без approve не выполняется; reject → APPROVE_REJECTED; вечный needs_fix → RETRIES_EXHAUSTED». Риск: висящие approve (лечится TTL + cancel) и рост фронта (держать аддитивно). Addendum 2026-11-04: назад-рёбра только здесь; связка цикл→фон/журнал (детали — эпоха 5).
- **Эпоха 4 (новая) — три слоя tools + InferencePort.** `SkillToolAdapter` (`.opencode/skills/*`, workflow-инжекция) + `McpToolAdapter implements AgentTool` (`tools/list`+`tools/call`, имена `mcp_*`) за единым `ToolRegistry` + allowlist на `{graph_id, mode}`; `InferencePort {chat, chatStream}` + адаптеры Zen (default, обёртка runner 1:1) / OpenAI-compat / Anthropic / Vercel-AI-SDK; Jev как заменяемый `ClassifierPort`; env strict без тихих фолбэков. Готовность: смена провайдера = 1 файл адаптера + env, домен/граф/SSE/журнал untouched.
- **Эпоха 5 (новая) — фон + журнал + стрим + горизонталь.** `RunQueueService` + `GraphWorker` в `processes/modules/workers/` (сейчас scaffold), pg-очередь SKIP LOCKED (выбрана vs BullMQ: ноль новых зависимостей — Redis в compose нет, Postgres уже обязателен); `POST /api/agent-runs → 201 {runId}`, SSE `GET .../:id/stream` по runId; stateless runner + advisory lock (2 реплики OK); append-only событие `{run_id, branch_id, node_id, kind, status, input/output/error, attempt, latencyMs, costUnits}`; snapshot графа в `agent_runs.input.graphSnapshot`. Готовность: POST <500ms; kill-mid-run → boot re-enqueue → тот же output; дабл-исполнения нет.

## Файлы: трогаются / создаются
- Создаются: `processes/modules/ai/modules/tools/{agent-tool.types,tool-registry.service,builtin/*.tool,skill-tool.adapter,mcp-tool.adapter}.ts`, `processes/modules/ai/modules/orchestrator/{graph.definition,graph-runner.service,budget.guard,graphs/auto-v2.graph}.ts`, `processes/modules/ai/modules/inference/{inference.port,zen-inference.adapter,openai-compat.adapter}.ts`, `processes/modules/workers/{run-queue.service,graph.worker}.ts`, миграции `drizzle/*_agent_runs_steps.sql` (+`agent_run_jobs`, поля `graphSnapshot/latency_ms/cost_units/branch_id`), эндпоинты в `sessions/` (`agent-runs.controller.ts`: POST run, GET steps/stream, POST approve/cancel), фронт `GraphTrace.tsx`/`ApproveCard.tsx`, contracts-дополнения.
- Трогаются (аддитивно, без ломки): `common/zen/session-runner.service.ts` (оборачивается `ZenInferenceAdapter`, опц. tools), `common/db/schema.ts` (+таблицы/поля), `session-harness.service.ts` (graph-кадры в SSE-буфер), `auto.agent.ts` (делегирование auto-v2, позже удаление chain), `contracts/openapi.yaml`.
- Не трогаются: `JevService` (только оборачивается `jev_classify` / `ClassifierPort`), EXTERNAL_*/ApiErrorFilter, auth-гарды, C4-гейт.

## Порядок внедрения и критерии общей готовности
1. Эпоха 0 → 2. Эпоха 1 (auto-v2 за флагом, старое Auto живо) → 3. Эпоха 2 (fanout только для fullstack-графа) → 4. Эпоха 3 (approve сначала только для новых write-tools, которых пока нет — точка зарезервирована) → 5. Эпоха 4 (skills/MCP read-only + InferencePort с Zen-адаптером 1:1, без смены default-провайдера) → 6. Эпоха 5 (фон-воркер + SSE по runId + журнал-событие; in-request исполнение эпохи 2 выводится из эксплуатации для графа). На каждом шаге: `bun run lint` + `build` + точечные e2e зелёные; старый Ask/Auto UX не деградирует (регресс-спеки эпохи 1 как gate).
