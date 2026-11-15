# Epoch 5: Фоновые воркеры + append-only журнал + SSE-стрим стейта + stateless-горизонталь

## Hypothesis
Требования 3 (расширяемость/масштабируемость), 4 (фон), 5 (журнал), 6 (стрим) — это один рантайм-слой поверх графа эпох 1–3: `GraphRunner` выполняется НЕ в HTTP-запросе, а в фоне; Postgres — единственное состояние (stateless runner); каждый переход пишется как append-only событие; фронт подписывается на стрим по `runId`. Без этого слоя циклы/approve вешают HTTP-соединения, а 2 реплики backend гоняют один run.

## Evidence Found
- File: `apps/backend/src/processes/modules/workers/workers.module.ts` — scaffold only (`@Module({})`); очередей (BullMQ/pg-queue) в репо НЕТ (`grep BullMQ|Queue` — пусто в src); фонового исполнения графа нет — epoch-02 §Decision «Promise.allSettled в одном процессе» предполагал исполнение в запросе.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` — `interrupt()` гасит прямой turn; `busyDirect/localFrames` в памяти (теряются при рестарте); `relaySse` + `toStreamFrame {id,type,data}` + фильтр `data.sessionID` + `bufferDirect*` (чунки 200, cap 500) — точка расширения стримом графа.
- File: `apps/backend/src/common/db/schema.ts` + epoch-01 §п.1 — `agent_runs/agent_steps` задуманы, но поле под snapshot графа и единый формат события не зафиксированы.
- Pattern: backend AGENTS.md — e2e через testcontainers postgres:16-alpine, `DATABASE_URL` в e2e не читается; prod-Postgres уже обязательная зависимость → pg-очередь не добавляет инфраструктуры.

## Decisions
- Decision (требование 4): **pg-очередь (SKIP LOCKED поверх Postgres), НЕ BullMQ.** Обоснование: минимум новых зависимостей (Redis для BullMQ в compose/ops отсутствует; Postgres уже есть и обязателен); надёжность достаточна для v1-объёмов (единицы run-ов, шаги ≤15, ветки ≤4): `agent_run_jobs {run_id PK, status queued|running|done|failed, locked_by, locked_at, attempts}` + `SELECT ... FOR UPDATE SKIP LOCKED` в воркере `GraphWorker`. BullMQ (Redis) — только если позже понадобятся задержки/повторы/rate-limit из коробки или очереди >100 rps. `WorkersModule` (`processes/modules/workers/`) — дом для `GraphWorker` + `RunQueueService`, а не новый топ-модуль.
- Alternatives considered: BullMQ+Redis — отвергнут для v1: +1 stateful-зависимость (compose, Dokploy, бэкапы, e2e-контейнер), выигрыш не окупается при наших объёмах; in-request исполнение (epoch-02) — отвергнуто для графа v2+: висящие approve/циклы держат HTTP 90s+ и теряются при рестарте.
- Rationale: `POST /api/agent-runs {graph_id, input}` → `201 {runId}` сразу (создаёт run + enqueue); фронт подписывается на SSE по runId; воркер исполняет `GraphRunner` пошагово (после каждого узла — persist + SSE-кадр); связка с существующим `interrupt`: `POST .../cancel` ставит `failed CANCELLED` + `AbortSignal` гасит ветки (ответ на Open Question эпохи 3 §п.1: cancel отдельно от session-interrupt, reuse сигнала).
- Decision (требование 3): горизонталь = **stateless runner + Postgres как единственное состояние**: воркер не хранит курсор в памяти; захват run-а через `pg_advisory_xact_lock(hashtext(run_id))` (или `locked_by+locked_at` lease при SKIP LOCKED) → 2 реплики backend OK без дабл-исполнения; граф из кода+конфига с zod-валидатором (epoch-01 §п.2), snapshot в `agent_runs.input.graphSnapshot`, версия строкой `graph_id` (`auto-v2`, `auto-v3`…); resume после рестарта — пере-enqueue недобежавших run-ов при boot.
- Decision (требование 5): `agent_runs/agent_steps` — **append-only журнал** (UPDATE только на `status`/`output` своей строки шага; истории не переписываем); единое событие на каждый переход: `{run_id, branch_id, node_id, kind, status, input/output/error, attempt, latencyMs, costUnits}` — пишется в step + ду anticipated AppLogger-однострочник `[graph] node kind=… nodeId=… status=… runId=… branch=… attempt=… latencyMs=… cost=…` (без тел/ключей/URL, стек только в debug через `serializeCause ≤2000`); секрет-скан e2e на новые пути (эталон `keys.e2e.ts`).
- Decision (требование 6): SSE-кадры стейта **аддитивно поверх `relaySse/toStreamFrame`**: `graph.node.started|done|failed`, `graph.edge.taken`, `graph.branch.started|done`, `graph.join.done`, `graph.approve.required|resolved` — каждый с обязательным `data.sessionID` (иначе дроп фильтром) + `runId`; фронт-подписка `GET /api/agent-runs/:id/stream` (SSE, тот же envelope) + существующий harness-буфер; новые компоненты `GraphTrace.tsx` (лента узлов/веток) / `ApproveCard.tsx` (кнопки); старые клиенты игнорируют неизвестные `type` (контракт в `contracts/openapi.yaml` + `@rush-code/contracts`).

## Confirmed Plan Items
1. `RunQueueService.enqueue(runId)` + таблица `agent_run_jobs` + `GraphWorker` (poll `SKIP LOCKED`, advisory lock на run, зовёт `GraphRunner` пошагово) в `processes/modules/workers/` — причина: фон вместо HTTP; артефакт: `workers/run-queue.service.ts`, `workers/graph.worker.ts`, миграция jobs; валидация: e2e «POST вернул runId за <500ms; kill backend mid-run → boot re-enqueue → тот же output; 2 воркера → ни один tool не вызван дважды».
2. Расширение схемы: `agent_runs.input.graphSnapshot jsonb NOT NULL` + `output.usage {steps, costUnits}` + `agent_steps {branch_id nullable, latency_ms, cost_units}` + индекс `(run_id, node_id)` (уже в PLAN.md) — причина: resume по снапшоту + единый формат события; валидация: миграция + контракт-тест события.
3. `POST /api/agent-runs {graph_id, session_id, input}` → `201 {runId}` + `GET /api/agent-runs/:id/stream` (SSE) + `GET .../steps` (trace) + `POST .../approve` + `POST .../cancel` (C4-гейт + JwtAuthGuard + zod, каноном `sessions.controller.ts`) — причина: полный lifecycle run-а; валидация: e2e approve/reject/cancel/TTL-матрица из epoch-03 §п.2.
4. SSE-кадры графа через `relaySse/toStreamFrame` (аддитивно, `data.sessionID` обязателен) + документация в `contracts/openapi.yaml` + `@rush-code/contracts` — причина: стрим стейта без ломки старых клиентов; валидация: фронт-парсер не падает; ручной сценарий trace+ветки+approve.
5. Фронт `GraphTrace.tsx`/`ApproveCard.tsx` + подписка по runId (аддитивно к shimmer/`session.idle`, лайки untouched) — причина: видимость ветвлений/approve; валидация: юнит парсера кадров + ручной сценарий.
6. Наблюдаемость: AppLogger-сводка на узел (формат выше) + `GET steps` + e2e секрет-скан новых путей — причина: дебаг без слива секретов; валидация: скан зелёный.

## Open Questions (актуально до Addendum 2026-11-04 ниже)
- Poll-интервал воркера vs LISTEN/NOTIFY (достаточно ли poll 500ms–1s для v1 UX)?
- Нужен ли `GET /api/agent-runs?session_id=` (список run-ов сессии) в v1 или достаточно steps/stream по runId?

## Next Epoch Focus
- Валидация плана (plan-validator), Trello-карточки, старт эпохи 0. Новых эпох не планируется — дальше декомпозиция.

---

## Addendum 2026-11-04 — решения пользователя (event-driven + resume; stateless-воркер; git как журнал)

### A. Event-driven архитектура с возобновлением прерванного воркера
- Decision: воркер — consumer событий очереди; событие = строка `agent_run_jobs` (транспорт) + запись `agent_steps` (правда). Связка pg-очереди и журнала: **очередь = транспорт (доставка/lease), `agent_steps` = правда (состояние)** — очередь может потерять/повторить доставку, журнал — никогда не врёт (append-only + идемпотентность `(run_id,node_id,attempt)+dedupeKey`).
- Поток события (write-ahead/outbox, каждый шаг):
  1. `GraphWorker` забирает job (`SELECT ... FOR UPDATE SKIP LOCKED`, `locked_by/locked_at` lease) → пишет `agent_steps {node_id, kind, status:'started', attempt}` ДО исполнения (write-ahead) + AppLogger-однострочник;
  2. исполняет узел/тул (stateless: весь контекст — из `agent_runs/agent_steps`, см. §B);
  3. дописывает исход (`status done|failed|waiting_approve`, `output/error`, `latency_ms/cost_units`) + SSE-кадр `graph.*` + коммит события (см. §B git-часть для значимых шагов);
  4. кладёт следующее событие (enqueue next node/job) — outbox: следующее событие видимо только после commit текущего (нет висящих переходов).
- Resume-процедура прерванного воркера (пошагово):
  1. boot (или новый воркер): `SELECT runs WHERE status IN (running, waiting_approve)` + `steps WHERE run_id AND status IN (started, queued)` — незавершённые шаги;
  2. re-enqueue их job-ов (`agent_run_jobs` → `queued`, lease сброшен) — идемпотентно по `(run_id,node_id,attempt)`;
  3. перечитать журнал `agent_steps ORDER BY started_at` + `git log <base>..<branch>` (второй источник, §B) → восстановить курсор (последний `done`, первый незавершённый);
  4. доисполнить незавершённые шаги со СТАРЫМ `attempt` при повторе той же попытки (платные вызовы не дублируются через dedupeKey) или `attempt+1` при ретрае по политике;
  5. закрыть run (`done|failed`) только когда все шаги терминальны; дабл-исполнение исключено advisory lock / lease (валидация эпохи 5 п.1 без изменений).
- Alternatives considered: состояние в памяти воркера с checkpoint «после» — отвергнуто (теряется при kill между исполнением и записью; write-ahead закрывает окно).

### B. Stateless-воркер + git-репозиторий проекта как durable-артефакт и второй журнал
- Decision: воркер stateless — никакого локального состояния между итерациями (нет курсора/кэша шагов в памяти; `busyDirect/localFrames` harness-а — не источник правды для графа). Весь контекст — из Postgres-журнала (`agent_runs` incl. `input.graphSnapshot` + `agent_steps`) + git-репозиторий проекта.
- Git как журнал: каждый значимый шаг (write/external-мутация графа) — коммит в project repo; read-only шаги (condition/classifier/read-tools) — только Postgres, без коммитов (матрица ниже).
- Ветка на run: `agent/<runId>` ответвляется от `baseCommit` (фиксируется в `agent_runs.input {baseCommit, branch}` при `POST /api/agent-runs`); вся работа run-а — только в своей ветке; завершение — только вперёд (merge/PR в базу, ветка не удаляется до TTL аудита).
- Формат сообщения коммита шага (фиксирован):
  `chore(agent): <node_id> <summary>` + тело-трейлеры:
  `Run: <run_id> Node: <node_id> Attempt: <n>` (+ опц. `Branch: <branch_id>`)
  Пример: `chore(agent): impl-auth add login handler\n\nRun: 0193... Node: impl-auth Attempt: 1`.
- Правило Forward-Only (репо-конвенция, обязательно в PLAN.md/контракте эпохи): **никогда `reset --hard` / `push --force`** в ветках `agent/*`; откат — только `revert`-вперёд (новый коммит с тем же трейлером `Run/Node/Attempt+1`); нарушение → fail code-review/lint-гейт.
- Resume через git: `git log --oneline <baseCommit>..<agent/branch>` + сверка с `agent_steps` (трейлер `Run/Node/Attempt` ↔ step): шаг с коммитом, но без `done` в Postgres → дописать исход (commit раньше write-ahead-противоречия не создаёт — правда всё равно Postgres); шаг `done` без коммита (write-шаг) → переисполнить как новый `attempt+1` (идемпотентный revert-вперёд при дубле).
- Что в git, а что в Postgres (матрица):
  | Слой | Git (project repo) | Postgres (`agent_runs/agent_steps`) |
  |---|---|---|
  | Код-артефакты (файлы, диффы шагов) | ✅ коммиты `agent/<runId>`, формат выше | только ссылки (`output {commitSha, branch}`) |
  | События/переходы/состояние (started/done/failed, attempt, latency, cost) | ❌ (только трейлеры для сверки) | ✅ append-only правда |
  | Approve (required/resolved, TTL) | ❌ | ✅ `waiting_approve` + `POST .../approve` |
  | Классификаторы/условия/read-наблюдения | ❌ | ✅ steps без коммитов |
  | Откат | ✅ `revert`-вперёд | ✅ новый step `attempt+1` |
- Валидация (дополняет п.1 эпохи 5): e2e «kill mid-write-step → resume: git-log + steps сходятся, платный вызов не повторён, следующий коммит — revert-вперёд при конфликте».
