# Epoch 3: Циклы/ретраи + human-approve + наблюдаемость (steps/trace в SSE и логах)

## Hypothesis
Замыкаем систему: (а) ограниченные циклы — ребро-назад с `maxRetries` + условие выхода (self-critique: агент проверяет свой output, не прошёл → повтор с feedback, максимум K раз); (б) human-in-loop — узел `approve` переводит run в `waiting_approve`, фронт показывает diff/план с кнопками Approve/Reject, продолжение — отдельным эндпоинтом; (в) наблюдаемость — персистентный trace (steps уже есть) + SSE-лента + AppLogger-сводка на run (один info на узел, без тел).

## Evidence Found
- File: `session-harness.service.ts` — `interrupt()` уже умеет гасить прямой turn + `bufferDirectIdle` гасит висящий sending-флаг — образец для approve-timeout (не висим вечно).
- File: `sessions.controller.ts` — REST-поверхность `/api/sessions*` (JwtAuthGuard, C4-гейт) — новые `GET /api/agent-runs/:id/steps`, `POST /api/agent-runs/:id/approve` лягут рядом тем же каноном.
- File: `apps/frontend/.../useChat` (frameText:152, send():444) — фронт финализирует sending только по `session.idle`; shimmer-статусы + локальные лайк/дизлайк — точка встройки approve-карточки и trace-панели.
- Pattern: auth-гейты на контроллерах (agents.controller.security.spec), e2e-скан секретов (keys.e2e эталон).

## Decisions
- Decision: approve — синхронная точка с TTL (default 10 мин): `waiting_approve` + `approve_expires_at`; timeout → `failed code=APPROVE_TIMEOUT`, run можно перевыполнить (re-run с того же узла, идемпотентность эпохи 2).
- Alternatives considered: (а) асинхронные webhook-approve — отвергнуто для v1: нет внешнего потребителя; (б) auto-approve всего read-класса без точек — принято как часть решения (read-инструменты идут без approve, write/external — всегда через approve).
- Rationale: баланс безопасности и UX: чтение не блокируем, мутации (запись файлов, внешние вызовы) — только с явного согласия.

## Confirmed Plan Items
1. Рёбра-назад: `edge {from: 'review', to: 'fix', when: 'needs_fix', maxRetries: 2}` + счётчик в state; валидатор эпохи 1 расширен: любое назад-ребро обязано иметь maxRetries, join нельзя зациклить — причина: циклы без кап = бесконечные деньги; артефакт: `graph-runner` retry-счётчик; валидация: юнит «review всегда needs_fix → ровно 1+2 попытки → failed RETRIES_EXHAUSTED».
2. Узел `approve {summaryFrom, payloadSchema, ttlMs}`: runner ставит run на паузу, пишет step `waiting_approve`, SSE-кадр `graph.approve.required {runId, nodeId, summary}`; эндпоинты `POST /api/agent-runs/:id/approve {decision: approve|reject, comment?}` (C4-гейт + JwtAuthGuard, zod) → runner продолжает/бросает — причина: human-in-loop для мутаций; валидация: e2e «write-tool без approve не выполняется; reject → run failed APPROVE_REJECTED».
3. Jail/гейты для инструментов (сквозная безопасность): каждый tool-handler получает ctx {projectId, userId, directory (jail), approved: boolean}; write/external без approved=true → throw 403 до вызова; пути через WorkspacePathService (REPOS_ROOT, иначе 503, не cwd) — причина: инструмент не должен выйти из джейла даже если LLM попросит; валидация: security-спек «tool просит /etc/passwd → отказ».
4. Наблюдаемость: (а) `GET /api/agent-runs/:id/steps` — trace-лента из agent_steps (уже есть с эпохи 1); (б) SSE-кадры `graph.node.*|graph.edge.taken|graph.branch.*|graph.approve.*` документированы в contracts (openapi.yaml + @rush-code/contracts); (в) логи: один `info [graph] node kind=nodeId status=done runId=…` + debug с serializeCause (≤2000), без тел/ключей — причина: дебаг ветвлений без слива секретов; валидация: e2e-скан секретов по новым путям.
5. Фронт (минимально, без редизайна): trace-панель под ответом (список узлов со статусами из новых кадров), approve-карточка (summary + Approve/Reject), fan-out полосы — всё аддитивно, старые shimmer/лайки untouched — причина: показать ветвления пользователю; артефакт: `apps/frontend/src/.../GraphTrace.tsx`, `ApproveCard.tsx`; валидация: ручной сценарий + юнит парсера кадров.

## Open Questions
- Нужна ли отмена run (cancel) отдельно от существующего interrupt? (рекомендация: да, `POST .../cancel` гасит ветки через AbortSignal + ставит failed CANCELLED).
- Хранить ли полный graph-definition snapshot в agent_runs (да — иначе миграция графа сломает resume старых run-ов)?

## Next Epoch Focus
- Валидация плана (plan-validator), разбиение на Trello-карточки, старт эпохи 0.

## Addendum 2026-11-04 — циклы как назад-рёбра, иерархия классификаторов, связка с фоном/журналом (требования 1+4+5, без переписывания выше)
- **Назад-рёбра живут здесь (§п.1 выше) и только здесь:** формат `edge {from:'review', to:'fix', when:'needs_fix', maxRetries:2}`; счётчик `attempt` в state + персист в `agent_steps.attempt`; валидатор: назад-ребро без `maxRetries` → reject; `join` нельзя зациклить; вечный `needs_fix` → `failed RETRIES_EXHAUSTED` (e2e-критерий §п.1). Forward-условия при этом определены в epoch-01 Addendum (condition-узлы), здесь — только замыкание назад.
- **Иерархия классификаторов в циклах:** `review` — это либо второй `classifier-node` (LLM-судья `needs_fix|ok`), либо детерминированный предикат; выход `ok` идёт вперёд (`default → merge/synthesize`), `needs_fix` — назад (`→ fix`, каapped). Лимит глубины классификаторов (≤2) из epoch-01 Addendum действует и внутри цикла: `fix → review` не плодит третий классификатор без смены `graph_id`.
- **Связка с фоном (требование 4, детали — epoch-05):** цикл выполняется тем же `GraphRunner`, но вызванным из воркера, а не из HTTP-хендлера; `waiting_approve` внутри цикла ставит run на паузу без удержания HTTP-соединения (продолжение — `POST .../approve` → re-enqueue).
- **Связка с журналом (требование 5, детали — epoch-05):** каждая итерация цикла = отдельная строка `agent_steps` с инкрементом `attempt` (append-only, апдейтов истории нет); событие унифицировано `{run_id, branch_id, node_id, kind, status, attempt, latencyMs, costUnits}`.
