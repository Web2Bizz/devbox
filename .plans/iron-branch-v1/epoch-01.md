# Epoch 1: Граф-оркестратор (узлы, условные рёбра, состояние в Postgres)

## Hypothesis
Поверх реестра инструментов строим минимальный собственный движок графа: `GraphDefinition { nodes, edges }`, где узел = {id, kind: 'agent'|'tool'|'condition'|'merge'|'approve', ref, inputMapping}, ребро = {from, to, when?: predicate|'default'}. Исполнение — `GraphRunner` (NestJS provider): топологический обход с вычислением условий от выхода узла, состояние персистится в Postgres после КАЖДОГО узла (рестартобезопасность). AutoAgent становится одним из графов («router→chain»), а не особым кодом.

## Evidence Found
- File: `apps/backend/src/processes/modules/ai/modules/agents/auto.agent.ts` — `runChain` уже есть зачаток графа: decompose→loop steps→synthesize, но захардкожен, без условий и персистентности (results в памяти).
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` — `busyDirect: Set` и `localFrames: []` в ПАМЯТИ (теряются при рестарте); durable — только `SessionHistoryRepository` (session_messages/session_agents/project_sessions). Паттерн восстановления уже есть (list из store при падении стенда).
- File: `apps/backend/src/common/db/schema.ts` — таблицы истории, soft-delete правило, RESTRICT FK; образец для новых таблиц.
- Pattern: `relaySse` + `toStreamFrame` ({id,type,data}+hoisted session) — точка расширения для прогресса веток.

## Decisions
- Decision: свой минимальный движок, НЕ LangGraph, НЕ Vercel AI SDK (обоснование — отдельно в PLAN.md §выбор движка).
- Alternatives considered: LangGraph (зрелые циклы/checkpointing) / Vercel AI SDK (удобный стриминг) — отвергнуты: чужой рантайм ломает per-user ключи, EXTERNAL_* envelope, AppLogger-каноны, Jev-биллинг, Drizzle-миграции; тащить зависимость ради 200 строк обхода графа невыгодно.
- Rationale: граф ~150-250 строк + zod-валидация определения; полный контроль над approve-точками, бюджетами, SSE-кадрами; вписывается в NestJS DI.

## Confirmed Plan Items
1. Схема БД (Drizzle, `drizzle/`-миграция): `agent_runs {id uuidv7 PK, session_id text, project_id uuid RESTRICT, graph_id text, status: running|waiting_approve|done|failed, input jsonb, output jsonb, created_at, updated_at, deleted_at}` + `agent_steps {id uuidv7 PK, run_id FK CASCADE, node_id text, kind text, status, input jsonb, output jsonb, error jsonb, attempt int, started_at, ended_at}` — причина: продолжение после рестарта = `SELECT steps WHERE run_id` → достроить недобежавшие узлы; артефакт: `common/db/schema.ts` + миграция; валидация: e2e «kill backend mid-run → resume даёт тот же output».
2. `GraphDefinition` zod-схема + валидатор (все `to` существуют, ровно один start, нет висячих when без default, условие — из белого списка предикатов) — причина: граф приходит из кода/конфига, не от пользователя (инъекция графа = RCE); артефакт: `orchestrator/graph.definition.ts`; валидация: юнит «цикл без retry-капа → reject на валидации».
3. `GraphRunner.run(runId, definition, input, ctx)` : цикл «взять готовые узлы → выполнить (agent через AgentsService / tool через ToolRegistry) → записать step → вычислить рёбра → следующие» — причина: сердце ветвлений; артефакт: `orchestrator/graph-runner.service.ts`; валидация: юнит на условный переход (Jev route=frontend идёт в frontend-ветку).
4. Первый боевой граф `auto-v2`: `classify (jev tool) → condition route → backend|frontend|fullstack agent → synthesize` — поведение 1:1 со старым AutoAgent (регресс-тест старыми спеками должен зеленеть) — причина: доказать замену без регресса; артефакт: `orchestrator/graphs/auto-v2.graph.ts`.
5. SSE: новые кадры `graph.node.started|done|failed {runId, nodeId, kind}` и `graph.edge.taken {from,to}` через существующий `toStreamFrame`/`bufferDirect*` (data.sessionID обязателен, иначе фильтр дропнет) — причина: наблюдаемость без ломки контракта (старый фронт игнорирует неизвестные type, новый рисует дерево); валидация: фронт-парсер не падает на новых кадрах.

## Open Questions
- DSL условий: простые JS-предикаты в коде графа vs декларативные `{equals, contains}` в JSON? (рекомендация: код для v1, JSON позже).
- Один run = один user message или долгоживущий run на сессию?

## Next Epoch Focus
- Параллельность: fan-out/fan-in (join), конкурентное выполнение веток, бюджеты.

## Addendum 2026-11-04 — циклы/классификаторы, конфиг-граф, версионирование (покрытие требований 1+3, без переписывания выше)
- **Condition-узлы живут здесь (epoch-01 §п.2–4):** `condition { predicate: <имя из белого списка>, when/default рёбра }` — предикат выполняется кодом раннера от output предыдущего узла (не LLM-текстом). Белый список предикатов фиксируется в `orchestrator/graph.definition.ts` zod-валидатором; произвольные eval/JSON-DSL запрещены в v1.
- **Classifier-node (требование 1):** Jev — НЕ только STEP 0 `AutoAgent.ask` (`auto.agent.ts:60-62`), а переиспользуемый узел `classifier-node { ref: 'jev_classify' | другой адаптер, outputMapping: {route} }`, за которым идёт `condition route`. Первый граф `auto-v2` (§п.4 выше) — частный случай: `classify → condition route → backend|frontend|fullstack → synthesize`.
- **Иерархия классификаторов (требование 1):** доменный (`jev_classify`: backend|frontend|fullstack|unclear) → уточняющий (опциональный второй classifier-node внутри ветки, напр. `fullstack → be_vs_fe_ratio` или `risk_classify: read|write|external`). Уточняющий узел — тот же тип `classifier`, другой `ref`; валидатор разрешает цепочку `classifier → condition → classifier → condition` (глубина ≤2 в v1, лимит в BudgetPolicy).
- **Назад-рёбра НЕ живут здесь** — только forward `when|default`; назад-рёбра с `maxRetries` — epoch-03 §п.1 (там же счётчик попыток + `RETRIES_EXHAUSTED`). Валидатор epoch-01 уже сейчас реджектит цикл без капа (см. §п.2 «цикл без retry-капа → reject»), полная семантика — в epoch-03.
- **Граф из кода+конфига + версионирование (требование 3, детали — epoch-05):** определение графа = TS-файл (`graphs/auto-v2.graph.ts`) + zod-валидация при загрузке; `graph_id` версионируется строкой (`auto-v2`, `auto-v3`…); snapshot определения пишется в `agent_runs.input.graphSnapshot` при старте run-а (resume идёт по снапшоту, не по текущему коду — ответ на Open Question epoch-03 §п.2: да, храним).
