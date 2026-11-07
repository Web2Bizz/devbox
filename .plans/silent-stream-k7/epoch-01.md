# Epoch 1: Coarse hypothesis — нет стрима инструментов

## Hypothesis
- Симптом честный: host-исполнение работает (файл создан), но в чате пусто кроме user-сообщения — `streamingText` пуст, прогресса нет.
- Host эмитит `session.tool.called/progress/success/failed`, `session.tool.input.*`, `session.reasoning.*`, а фронт в `useChat.ts:124-181 frameText` их дропает (`null → continue`), `frameToolName :193-204` ждёт только legacy `message.part.updated`, `chat-tools-timeline.tsx` рисует только псевдо-`toolTrace` (prompt/sse).
- Возможно фильтр `?session=`/resolve дропает или терминатор `text.ended/step.ended` не приходит, поэтому финальный текст не коммитится в messages.
- SSE-контракт можно расширять аддитивно, фронт-канон из `apps/frontend/AGENTS.md` соблюдать (useEffect-исключение, слои, no-opencode-transport guard).

## Evidence Found
- Task statement: ветка `feat/cli-cloud-chat`, корень `/media/codebase/@web2bizz/devbox`.
- Файлы-кандидаты из постановки: `apps/frontend/src/hooks/useChat.ts`, `apps/frontend/src/api/sessions-client.ts`, `apps/frontend/src/components/chat/chat-window/chat-tools-timeline.tsx`, `agent-thinking.tsx`, `chat-window.tsx`; бэк `sessions/session-harness.service.ts` (`toStreamFrame`/`recordHostEvent`), контракты `sessions.schema.ts`.
- Факт из постановки: auto создал файл — бэкенд-путь исполнения цел, проблема в проекции стрима на UI.

## Decisions
- Decision: идём evol-планом medium (5 эпох) → Trello-карточки diag→fix→verify, только план, без кода.
- Alternatives considered: сразу чинить без диагноза — отвергнуто (риск сломать SSE-контракт и молчаливый дроп других типов).
- Rationale: сначала доказать какой кадр теряется где, потом чинить.

## Confirmed Plan Items
1. Зафиксировать target state — reason: нужен проверяемый done; artifact: критерии в PLAN.md; validation: ревью постановки.
2. Собрать доказательства по всем слоям — reason: гипотеза без файлов ненадёжна; artifact: epoch-02; validation: точные пути/строки.

## Open Questions
- Какие реальные типы эмитит host в auto-режиме (список из раннера/opencode-стенда)?
- `frame.session` vs `?session=` фильтр — дропает ли foreign-session кадры?
- Терминатор приходит ли (`text.ended`/`step.ended`/`execution.succeeded`) или теряется в relay?

## Next Epoch Focus
- Evidence gathering: прочитать useChat frameText/frameToolName/SSE-цикл, sessions-client парсер, harness toStreamFrame/recordHostEvent/streamEvents, contracts schema, chat-window/timeline/agent-thinking рендер.
