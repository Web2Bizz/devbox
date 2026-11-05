# Epoch 2: Параллельные ветки + join + бюджеты (max steps, cost guard)

## Hypothesis
Расширяем раннер эпохи 1 параллелизмом: узел `fanout` порождает N дочерних веток (каждая — свой sub-state со своим node-курсором), узел `join` ждёт ВСЕХ (стратегии: all | any-first | majority) и сливает результаты детерминированным merger-ом (concat | synthesize-через-агент). Параллелизм ограничён бюджетами: fan-out cap, max steps per run, max tool iterations, токен/вызов-кост guard (Jev платный — каждый classify считается). Превышение = честная остановка с частичным результатом, не молчаливый дроп.

## Evidence Found
- File: `auto.agent.ts` — `MAX_STEPS=5`, `CONTEXT_LIMIT=6000` — уже существующие бюджеты-одиночки; обобщаем на граф.
- File: `session-runner.service.ts` — `CHAT_TIMEOUT_MS=90000`, model guard (quota saver) — прецедент «дешевле отказать локально, чем жечь квоту».
- File: `session-harness.service.ts` — `bufferDirectFrames` чанкует ответ по 200 символов, буфер 500 кадров cap — прецедент ring-cap.
- Pattern: EXTERNAL_* + Retry-After для outage; 400 для локальных отказов (guard).

## Decisions
- Decision: параллельность через `Promise.allSettled` веток внутри одного run-процесса (не воркеры/очереди) для v1 — проще, хватает для 2-4 веток; очередь (BullMQ/pg-queue) — только если понадобится меж-инстансная горизонталь.
- Alternatives considered: (а) по процессу на ветку — отвергнуто: состояние в Postgres уже позволяет, но оркестрация усложняется; (б) полный DAG-параллелизм любого узла — отвергнуто для v1: только явный fanout/join, остальное последовательно (предсказуемость).
- Rationale: типичный кейс — fullstack: backend-ветка и frontend-ветка параллельно → join-синтез; 2-4 ветки в одном event-loop держат 90s таймауты без проблем.

## Confirmed Plan Items
1. Узлы `fanout {branches: [{node, inputMapping}]}` + `join {strategy, merger}` в `GraphDefinition`; валидатор: fanout обязан закрываться join, ветви не пересекаются — причина: предотвратить «потерянные» ветки; артефакт: расширение definition+runner; валидация: юнит «3 ветки → 3 step-ряда → 1 join».
2. `BudgetPolicy {maxFanout=3, maxStepsPerRun=15, maxToolIters=3, maxCostUnits, timeoutMsPerNode}` в ctx run-а; счётчик шагов/вызовов в `agent_runs.output.usage`; превышение → `status=failed` с `code=BUDGET_EXCEEDED` + частичные результаты в output — причина: защита от взрывного ветвления и Jev-счёта; артефакт: `orchestrator/budget.guard.ts`; валидация: юнит «fanout 10 при cap 3 → 400 до единого вызова».
3. Join-стратегии: `all` (ждать всех, fail если любая failed — классика), `any-first` (первый успех гасит остальных через AbortSignal), `synthesize` (все результаты → агент-мерджер) — причина: покрыть «быстрейший wins» и «слияние»; валидация: юнит на каждую стратегию.
4. Идемпотентность узлов: ключ `(run_id, node_id, attempt)` + `dedupeKey` из input-хэша; повторный запуск узла с тем же dedupeKey возвращает записанный output без повторного вызова (важно для ретраев после рестарта и для платных Jev/tool вызовов) — причина: не жечь деньги дважды; артефакт: проверка в runner перед handler; валидация: e2e «рестарт mid-fanout → ни один tool не вызван дважды».
5. SSE: `graph.branch.started {branchId, parentNode}` / `graph.join.done {mergedCount}` + фронт-отрисовка параллельных полос (аддитивно к shimmer-статусам; старые клиенты игнорируют) — причина: пользователь видит, что работают 2 ветки, а не «виснет».

## Open Questions
- Cost unit: считать вызовы (1 Jev = 1 unit, 1 chat = 1 unit) или токены из upstream usage? (рекомендация: вызовы для v1 — токенов endpoint может не вернуть).
- Нужен ли кросс-инстанс лок (advisory lock) на run, если backend поднимется в 2 репликах?

## Next Epoch Focus
- Циклы/ретраи, human-approve точки, наблюдаемость (steps/trace).
