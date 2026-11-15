# PLAN — Чат как связанный список типизированных узлов (chat-linked-nodes-l7)

Ветка: `feat/chat-commit-cur`. Корень: `/media/codebase/@web2bizz/devbox`.
Статус: **только план**, кода нет. Реализация — отдельной сессией после подтверждения.

## Задача (требование)

В чате вызовы инструментов должны быть **отдельными последовательными узлами**, а не бейджем/строкой trace:

```
<agent-message/>
<tool-calling/>
<tool-calling/>
<agent-message/>
<agent-message/>
```

- Вызов инструмента — **самостоятельное сообщение/узел** в списке.
- Работать нужно не с «сообщениями», а со **структурой связанного списка**: сообщения ИИ-агентов разных типов.
- Связанный список **привязан к промпту пользователя**, чтобы можно было сделать **повторный запрос (retry)**, если результат не подошёл.
- Это **отдельное исправление** (переделка модели чата).

## Диагностика (почему tool-вызовы «не видны») — подтверждено кодом

1. **Live-only**: кадры `session.tool.*` нигде не персистятся → после reload их нет.
2. **Нет `callId`**: кадры несут только имя (`data.tool`), нет стабильного id → нельзя ни upsert-узел, ни связать `called → success`.
3. **Дедуп по имени**: `useChat` держит `Set<tool>` (`toolCalled`/`toolDone`) → два вызова одного инструмента схлопываются в одну строку.
4. **Recorder не видит in-process**: `AssistantRecorderService` подписан только на host-бус, а `auto` идёт в `SessionFrameBufferService` → durable tool-узлы для auto сейчас невозможны.
5. **Фантомы в direct**: `DirectTurnService` эмитит фейковые `session.tool.*` с `tool: agentId` — это маркер агента, а не вызов; в `tool-calling` узлы превращать нельзя.

## Текущее состояние (baseline, подтверждено чтением)

- Durable история: `apps/backend/src/common/db/schema.ts:145` — `session_messages` (`id, session_id, project_id, user_id, role, agent_id, text NOT NULL, created_at, deleted_at`). Только текст; нет типа узла/родителя/payload.
- Контракт: `packages/contracts/src/sessions/sessions.ts:130` + `sessions.schema.ts` `sessionMessageSchema` — `{ id, type: string, createdAt, text: string|null }`.
- SSE: `session.tool.called/progress/success/failed` (+`input.*`), `session.text.*`, `message.part.*`, `session.reasoning.*`, `session.step.*`, `session.execution.*` (`sessions.schema.ts:228-341`). Tool-кадры live-only.
- Backend: `.../sessions/modules/recorder/assistant-recorder.service.ts` пишет только текст; `.../messaging/in-process-turn.service.ts:234-243` публикует `session.tool.success/failed` (без `callId`/`input`); `.../messaging/direct-turn.service.ts:131-145` — фейковые tool-маркеры.
- Frontend: `apps/frontend/src/hooks/useChat.ts` — `messages: ChatMessage[]` (durable, `at`) + `toolTrace: ChatToolEvent[]` (live-only); `components/chat/chat-thread/ChatThread.tsx:41-64` мержит по `at` (`buildThreadRows`). `finalize()` коммитит ассистента с локальным `newId()` (не durable id).
- `ToolCall = { id, name, arguments }`, `ToolSettlement = { callID, name, result }` (`tool-runtime.types.ts`).
- Следующая миграция: `0009` (последняя `0008_vault_secrets.sql`).
- OpenAPI: `contracts/openapi.yaml` (корень репо).
- План LLM-слоя: `.plans/langchain-openrouter-migration/PLAN.md` (сейчас «durable history — только текст» — это требование его меняет).

## План: карточки (строго по порядку)

### CARD 1 — Диагностика: где теряются tool-кадры
- **Depends on:** —
- **Files:** `.../sessions/modules/messaging/in-process-turn.service.ts`, `.../messaging/direct-turn.service.ts`, `.../recorder/assistant-recorder.service.ts`, `.../events/session-frame-buffer.service.ts`, `.../events/session-stream.service.ts`, `apps/frontend/src/hooks/useChat.ts`, `apps/frontend/src/components/chat/chat-thread/ChatThread.tsx`.
- **Checklist:** зафиксировать матрицу транспортов (auto→InProcess/buffer; ask+key→Direct/buffer; ask без key→Host/host-бус); подтвердить 5 причин выше; e2e-наблюдение (auto с 2 вызовами одного инструмента = 1 строка сейчас).
- **Artifact:** диагностическая записка в карточке.
- **Validation:** ревью записки.
- **complexity:** low / 4 · **risk:** low / 1.

### CARD 2 — Схема БД: типизированные узлы + связи (расширяем `session_messages`)
- **Depends on:** C1
- **Решение:** расширяем `session_messages`, не новая таблица (repository/fork/revert/list уже работают с ней; backward-compat через `kind='message'`; есть `deleted_at`/индексы/FK).
- **Files:** `apps/backend/src/common/db/schema.ts` (145-170), `apps/backend/drizzle/0009_session_entries.sql`, `apps/backend/drizzle/meta/_journal.json` + `meta/0009_snapshot.json`, `db:check-integrity`.
- **Checklist:**
  - колонки (nullable, кроме `kind` с default): `kind text NOT NULL DEFAULT 'message'` (`message|tool-calling|reasoning`), `parent_id text NULL`, `prompt_id text NULL` (для user-узла `prompt_id = id`), `payload jsonb NULL` (`{tool, callId, input, status, result?, error?}`), `seq bigint NULL`.
  - `text` → nullable (`DROP NOT NULL`), т.к. tool/reasoning без текста.
  - индексы: `(session_id, seq)`, `(session_id, prompt_id)`; старый `(session_id, created_at)` оставить.
  - миграция идемпотентна; backfill `seq` (`row_number() OVER (PARTITION BY session_id ORDER BY created_at)`) и `prompt_id` (user=id, assistant — ближайший предыдущий user) отдельным шагом.
  - `bun run db:check-integrity`.
- **Validation:** `session-history.repository.spec.ts` под новые поля; миграция на пустой и заполненной БД.
- **complexity:** medium / 9 · **risk:** medium / 4 (**data**, **breaking**).

### CARD 3 — Контракт: `SessionEntry` union + zod + OpenAPI
- **Depends on:** C2
- **Files:** `packages/contracts/src/sessions/sessions.ts`, `sessions.schema.ts`, `index.ts`, `contracts/openapi.yaml`.
- **Checklist:** аддитивный discriminated union `SessionEntry`:
  - Base `{ id, sessionId?, promptId: string|null, parentId: string|null, seq: number, createdAt }`;
  - `user` `{ kind:'user', text }`; `agent-message` `{ kind:'agent-message', text, agentId? }`; `tool-calling` `{ kind:'tool-calling', tool, callId, status:'called'|'success'|'failed', input?, result?, error? }`; `reasoning` `{ kind:'reasoning', text }`.
  - `sessionEntrySchema = z.discriminatedUnion('kind', …)`, `sessionEntryListSchema`; legacy `SessionMessage`/SSE не ломаем; в tool-кадры добавить **опциональные** `entryId/parentId/promptId`.
  - зеркало `contracts/openapi.yaml` поле-в-поле; `satisfies z.ZodType<…>`.
- **Validation:** `bun run test`/`lint` в `packages/contracts`; parse/reject по каждому `kind`.
- **complexity:** medium / 8 · **risk:** medium / 3 (**breaking**, **external**).

### CARD 4 — Backend: durable-канал узлов + SSE с id-связями
- **Depends on:** C2, C3
- **Files:** `.../sessions/session-history.repository.ts`, `.../messaging/in-process-turn.service.ts`, `.../messaging/direct-turn.service.ts`, `.../recorder/assistant-recorder.service.ts`, `.../events/session-frame-buffer.service.ts`, `.../events/session-stream.service.ts`, `.../sessions/sessions.types.ts`.
- **Checklist:**
  - repository: `appendEntry(kind/parentId/promptId/payload/seq)`, `updateEntryStatus(id, status, result/error)` (upsert `tool-calling` по `callId`), `listEntries(sessionId)` (orderBy `seq`); `listMessages` оставить совместимой проекцией.
  - `seq` — в repository (`max(seq)+1` в транзакции или PG sequence).
  - InProcess: `tool-calling` узел на каждый `ToolCall` (`status:'called'`, `callId`, `input` из `arguments`), `promptId` из `TurnMeta` (добавить), `parentId` = предыдущий узел; на `tool-result` — `updateEntryStatus` + эмит `session.tool.success/failed` с `entryId/parentId/promptId` (аддитивно).
  - Direct: маркеры `tool: agentId` **не** превращать в tool-узлы (фантомы).
  - recorder: единая точка через repository (host-бус + buffer), без второй реализации.
  - fork/revert: копировать `kind/payload/promptId/seq`.
  - логи `AppLogger` без тел `input/result` (только `tool/status/callId`).
- **Validation:** `session-history.repository.spec.ts`; `in-process-turn.spec.ts` (2 вызова одного инструмента → 2 узла); `sessions-stream.spec.ts`; e2e reload.
- **complexity:** high / 15 · **risk:** high / 6 (**breaking**, **data**, **security**).

### CARD 5 — Frontend: `useChat` linked list + upsert по `entryId`
- **Depends on:** C3, C4
- **Files:** `apps/frontend/src/hooks/useChat.ts`, `apps/frontend/src/api/sessions-client.ts`, `apps/frontend/src/api/client.ts`, `apps/frontend/src/hooks/__tests__/useChat.test.tsx`.
- **Checklist:** `ChatNode = { id, kind, promptId, parentId, seq, text?, tool?, status?, input?, result? }`; `toChatNodes(rows)` (не дропать `tool-calling`, порядок по `seq`); live `session.tool.*` → `upsertNode(entryId)` (не по имени); удалить merge-by-`at`; `streamingText` → временный `agent-message` с реальным `assistantId`; `finalize/failTurn/stop` коммитят с реальным id (без `newId()`); `reload/resync/verifyStuckSending` заменяют `nodes`.
- **Validation:** `useChat.test.tsx` — durable tool-узел рендерится; live обновляет существующий; reload сохраняет порядок; 2 вызова = 2 узла.
- **complexity:** high / 14 · **risk:** medium / 5 (**breaking**).

### CARD 6 — Frontend: `ChatThread` рендерит узлы (без merge-by-`at`)
- **Depends on:** C5
- **Files:** `.../chat-thread/ChatThread.tsx`, `.../chat-thread/types.ts`, `.../chat-tool-row/ChatToolRow.tsx` + `types.ts`, `apps/frontend/src/features/chat-section.tsx`, `apps/frontend/src/i18n/*`.
- **Checklist:** `buildNodeRows(nodes)` по `seq`; рендер `user/agent-message` → `ChatMessageRow`, `tool-calling` → `ChatToolRow` (расширить под `{tool,status,input,result}`), `reasoning` → thinking; live thinking/streaming — временные узлы в конце; не ломать `onFork/onRevert` (id узла); kit-токены.
- **Validation:** компонентные тесты/снапшоты порядка `user→tool→tool→agent→agent`.
- **complexity:** medium / 9 · **risk:** low / 2.

### CARD 7 — Retry: привязка к `promptId`, новая ветка/попытка
- **Depends on:** C5, C6
- **Files:** `.../sessions/sessions.controller.ts`, `sessions.service.ts`, `session-history.repository.ts`, `packages/contracts/src/sessions/*`, `apps/frontend/src/hooks/useChat.ts`, `.../chat-message/ChatMessageRow.tsx`, `.../chat-thread/*`, `contracts/openapi.yaml`.
- **Checklist:** `POST /api/v1/sessions/{id}/retry { projectId, promptId }` (или `POST messages` с `retryOfPromptId`) → новая ветка (`promptId` нового user-узла, `parentId` = родитель промпта); старые попытки целы; `GET messages` аддитивно отдаёт `attempt/branchOf` или `?promptId=`; UI-кнопка Retry + переключатель попыток; i18n.
- **Validation:** e2e retry создаёт ветку, старые узлы целы; `useChat` переключает попытку; guard `no-opencode-transport` зелёный.
- **complexity:** high / 12 · **risk:** medium / 5 (**breaking**, **data**).

### CARD 8 — ADR: durable = типизированные узлы
- **Depends on:** C4
- **Files:** `.plans/langchain-openrouter-migration/PLAN.md`, ссылка на `0009_*`, `apps/backend/package.json` (`db:check-integrity` в CI).
- **Checklist:** обновить «Durable vs live» (durable = `user/agent-message/tool-calling/reasoning`, live = дельты); отметить **breaking** (контракт/миграция, обратная совместимость через `kind='message'`); проверить CI-гейт.
- **Validation:** ревью; `db:check-integrity` зелёный.
- **complexity:** low / 3 · **risk:** low / 1.

## Волны

- **Волна 1 (видимость + reload):** C1 → C2 → C3 → C4 → C5 → C6.
- **Волна 2 (retry + ADR):** C7, C8 — после приёмки волны 1.

## Что переиспользуем (не дублировать)

| Существующее | Как |
|---|---|
| `session_messages` + индексы + `deleted_at` | расширяем колонками |
| `SessionHistoryRepository` | `appendEntry/updateEntryStatus/listEntries` |
| `AssistantRecorderService` | расширяем на tool-события; единая точка через repository |
| `SessionFrameBufferService` / `SessionStreamService` | passthrough `data` пропускает новые поля |
| `SessionMessage` / SSE-схемы | аддитивно, legacy сохранён |
| `ChatToolRow` | расширяем `types.ts`, не новый компонент |
| `useChat` (SSE-цикл, watchdog, finalize) | оставляем; меняем источник строк на `nodes` + upsert |
| `ChatMessageRow`, `ChatThinkingRow`, `MessageScroller` | без изменений |

## Complexity / risk (сводно)

```json
{
  "complexity": {
    "score": 17,
    "level": "high",
    "files": 24,
    "cards": 8,
    "deps": 9,
    "type": "update",
    "unknowns": 2
  },
  "risk": {
    "level": "high",
    "score": 7,
    "factors": ["breaking", "data", "security"],
    "mitigation": [
      "Аддитивный wire: SessionMessage/SSE не ломаем, новые поля optional, SessionEntry — новый union",
      "kind='message' DEFAULT сохраняет валидность старых строк; text NULL только для tool/reasoning",
      "Миграция 0009 идемпотентна + backfill seq/prompt_id отдельным шагом; db:check-integrity в CI",
      "Tool input/result фильтруются перед payload (без секретов/PII), AppLogger без тел",
      "callId как upsert-ключ; без owner — skip с warn (без тихих фолбэков)",
      "Direct-маркеры tool:agentId НЕ становятся tool-calling узлами (нет фантомов)",
      "e2e: reload auto-сессии с 2 вызовами одного инструмента = 2 durable узла"
    ]
  }
}
```

## Открытые вопросы (закрыть на старте реализации)

1. Точная форма `payload` и фильтрация секретов/PII перед записью `input/result`.
2. `callId` в host-пути (если host не даёт id — синтетический `callId = hostToolCallId ?? toolName+step`).
3. fork/revert: копирование `kind/payload/promptId/seq` (сейчас копируется только `text/role`).
4. Номер миграции — `0009` (подтверждено: последняя `0008`).

## Next Action

Подтвердить волну 1 (C1→C6) и запустить через `build-smart`: C1 (диагностика) → C2 (схема+миграция) → C3 (контракт) → C4 (backend durable) → C5 (frontend nodes) → C6 (UI). Retry (C7) и ADR (C8) — второй волной.
