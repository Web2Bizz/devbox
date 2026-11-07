# Epoch 4: Refinement — задачи diag/fix/verify в деталях

## Hypothesis
- Трёх карточек достаточно: D1 диагностика (доказать где дроп), F2 фикс проекции + статуса, V3 верификация auto-сценария. Каждая — файлы + чек-лист + complexity/риск + done.

## Evidence Found
- File: `apps/frontend/src/hooks/useChat.ts:472-473,491-506` — точка вставки tool-trace: рядом с `setActiveToolName` и delta/ended/committed переходами.
- File: `apps/frontend/src/hooks/useChat.ts:333-336 append, :341-353 finalize, :358-372 failTerminal` — точка проверки терминатора: finalize только при live turn, failTerminal только на stream.error.
- File: `apps/frontend/src/api/sessions-client.ts:236-274` — точка fail-soft подсчёта: `skipped` уже считается, можно пробросить в debug без тел.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts:1070-1195 relaySse/filterFrame/mapFrame` — точка diag-лога: тип + session-match без data.
- File: `apps/frontend/src/components/chat/chat-window/chat-window.tsx:141-197` — рендер уже готов к live tool (thinking + streaming статусы), нужен только сигнал.
- Pattern: `pushTrace(kind, label, detail?)` + `traceFlagsRef {connected,delta,ended,committed}` — расширить флагом tool-перехода once-per-turn, не per-frame (не спамить timeline).

## Decisions
- Decision: D1 — временный diag-режим (debug-лог сырых типов + счётчики дропа), не постоянный verbose; удаляется или глушится в F2.
- Alternatives considered: постоянный verbose-лог всех кадров — отвергнуто (шум, риск секретов в data).
- Rationale: нужен однопрогонный ответ «кадры доходят? фильтр режет? проекция дропает?».
- Decision: F2 — `frameToolName` расширить на `session.tool.*` (+ reasoning как detail, не tool), `frameText` не трогать кроме пропуска tool-типов мимо text-тракта с trace; добавить per-turn tool-trace события (`tool.called → progress → success/failed`).
- Alternatives considered: пихать tool-текст в streamingText — отвергнуто (портит финальный коммит ассистента, смешивает reasoning с ответом).
- Rationale: критерии — прогресс виден отдельно, финальный текст чист.
- Decision: V3 — ручной auto-сценарий (создание файла) + ассёрты: timeline-события > псевдо, activeTool виден, messages коммитится, EmptyState только до первого кадра; плюс `bun run lint` + `next build --turbopack` + guard-тест.
- Rationale: symptom-anchored verify, не синтетика.

## Confirmed Plan Items
1. D1 diag Hutch: сырые типы + фильтр-матч + дроп-счётчик — reason: различить бэк/фронт вину; artifact: useChat + harness debug; validation: лог одного auto-прогона.
2. F2 проекция tool-статуса + trace — reason: закрыть frameToolName-слепоту; artifact: useChat frameToolName/pushTrace + timeline/agent-thinking без переделки; validation: UI показывает прогресс.
3. V3 auto-верификация + регресс — reason: критерии постановки; artifact: чек-лист прогона + lint/build/guard; validation: done-условия.
4. Complexity/риск на каждую карточку — reason: требование; artifact: PLAN.md таблица; validation: наличие полей.

## Open Questions
- Точные имена полей tool-payload (`toolName vs tool vs name`, `input/progress/result`) — закроет D1-лог, F2 должен читать все три с guards.
- Нужен ли `session.reasoning.*` в timeline как collapsed detail или только в debug?

## Next Epoch Focus
- Validation: проверить план против канона/границ, проставить complexity/риск/done, собрать финальный PLAN.md + evolution-log.md.
