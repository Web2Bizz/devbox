# PLAN-DETAIL — Чат как связанный список типизированных узлов (chat-linked-nodes-l7)

Основа: `.plans/chat-linked-nodes-l7/PLAN.md` (C1–C8). Ветка `feat/chat-commit-cur`. Этот документ уточняет план по коду; код не пишется. Все ссылки проверены чтением файлов на момент составления.

> Chain 0009 (решения 2026-11-10, факт): `session_messages` = сообщения, `project_sessions` = чат, `projects` = проекты; `projects 1:N project_sessions 1:N session_messages` (оба RESTRICT); `session_messages.project_id` УДАЛЁН полностью; orphan-строки дропнуты; `session_id` text→uuid FK → `project_sessions.id`. Миграция: `apps/backend/drizzle/0009_session_chain.sql` (не wave-1 `session_entries`).

## 0. Новые факты, найденные при проверке кода (поправки к PLAN.md)

1. **In-process (auto) не публикует `session.tool.called` вообще.** `runner/runner.service.ts:131-177` публикует только `step-start`, `step-finish`, `finish` и `tool-result` (`data: {...settlement}` = `{callID, name, result}`). `in-process-turn.service.ts:228-243` (`publishFrame`) маппит `tool-result` → `session.tool.success|failed` (failed = `result.startsWith('error:')`), без `callID`. Поэтому для auto «called» из SSE не приходит; `input` (`ToolCall.arguments`) доступен только в `step.calls` внутри runner. Значит C4 обязан добавить публикацию `tool-call` фрейма из runner (или записать узел `called` прямо в runner через callback), а не только «на каждый ToolCall» в InProcess — последнее вообще не видит вызовов.
2. **`callID` уже есть в settlement** (`tool-runtime.types.ts:64-68`: `ToolSettlement = {callID,name,result}`), `ToolCall.id` (`:51`) — тот же id. Для auto `callId` **не синтетический** — берём `ToolCall.id`. Открытый вопрос №2 из PLAN.md касается только host-пути.
3. **Direct-фантомы подтверждены:** `direct-turn.service.ts:133` (`bufferDirectLifecycleStart`) пушит `session.tool.called` с `tool: agentId`; `:141-145` — `session.tool.success` с `tool: agentId`. Тот же фантом есть в `file-command.turn.ts:181`. Оба — кандидаты на отключение для tool-узлов (помечаются маркером, не `tool-calling`).
4. **`revert.service.ts:58`** использует `history.listMessages()` для позиционирования отката. Если `listMessages` начнёт возвращать tool/reasoning узлы — откат поменяет семантику. Поэтому: `listMessages` остаётся фильтром `kind IN ('message')` (или `kind='message' OR kind='user'`-проекция), а новый `listEntries` — полный список.
5. **`sessions.service.ts` fork (≈`:430-441`)** копирует только `role/text/agentId` через `appendMessage`, `id: Bun.randomUUIDv7()`. Для C4 нужно копировать `kind/payload/promptId/seq` (с переназначением `parentId`/`promptId` по карте old→new id).
6. **Контракт:** `packages/contracts/src/sessions/sessions.ts:130` `SessionMessage = {id, type: string, createdAt, text: string|null}`; `sessions.schema.ts:134-139` `sessionMessageSchema` с `satisfies z.ZodType<SessionMessage>`. OpenAPI: `contracts/openapi.yaml:2179` (`/api/v1/sessions/{id}/messages`).
7. **Frontend:** `useChat.ts:26-37` `ChatMessage = {id, role, text, at}`; `:53` `ChatToolEvent {id, at, kind: 'auth'|'create-session'|'history'|'prompt'|…|'tool'|'reasoning', …}`; дедуп `toolCalled/toolDone: Set<string>` (`:507-520`), логика в `:758-781`. `ChatThread.tsx:41-64` `buildThreadRows` сортирует по `at`, равные `at` — message первым. `ChatToolRow` props: `event?: ChatToolEvent`, `liveToolName?: string` (`chat-tool-row/types.ts`).
8. **Миграции:** последняя `apps/backend/drizzle/0008_vault_secrets.sql`; журнал `drizzle/meta/_journal.json`, снапшот `drizzle/meta/0008_snapshot.json`. Скрипт `db:check-integrity` = `bun src/common/db/schema-integrity.ts` (`apps/backend/package.json:18`), `schema-integrity.ts` ссылается на `sessionMessages` (строки 26, 100).
9. **Схема (chain 0009, факт):** `apps/backend/src/common/db/schema.ts` — `sessionMessages`: `id text PK`, `sessionId uuid FK → project_sessions.id RESTRICT`, `userId text`, `role text`, `agentId text null`, `text text NOT NULL`, `createdAt timestamptz default now NOT NULL`, `deletedAt null`. `project_id` УДАЛЁН (колонка+FK+индекс). Индекс: `session_messages_session_idx (session_id, created_at)`. Scope — JOIN `project_sessions`.
10. **Repository** `session-history.repository.ts`: `appendMessage` (insert + `onConflictDoNothing` по id, БЕЗ projectId; bump `projectSessions.updatedAt` всегда — uuid FK, ses_*-ветки нет), `discardMessage`, `listMessages(sessionId, projectId?)` (`orderBy createdAt`, `deletedAt IS NULL`, при projectId — INNER JOIN `project_sessions` + `project_sessions.projectId` + оба `deletedAt IS NULL`), `listSessionIdsWithMessages(projectId)` — через JOIN (прямого project_id нет), далее `setAgent/getAgent/listAgents/...`. Новых методов пока нет.
11. **TurnMeta** `sessions.types.ts:41-46`: `{userId, projectId, agentId, mode?}` — **нет `promptId`**. Устанавливается в `in-process-turn.service.ts:109` и `host-turn.service.ts:54`. Хранится в `session-runtime-state.service.ts` (`setTurnMeta/getTurnMeta/deleteTurnMeta`, Map).
12. **In-process send:** user-row пишется до модели (`in-process-turn.service.ts` ~`:95-108`, `id: receipt.id`), `assistantId = Bun.randomUUIDv7()` (`:117`), `runner.runTurn({ runId: receipt.id, publish: (f) => this.publishFrame(sessionId, assistantId, f) })`. Значит **`promptId = receipt.id`** уже доступен в scope send — это естественное значение для `TurnMeta.promptId`.
13. **Recorder:** `assistant-recorder.service.ts` подписан на host-бус (`subscribeEvents`, `:63`), фильтр `session.tool.*`/`session.reasoning.*` (`:134-140`) — live-only; финальный текст пишет `appendMessage` (`:~230`) с `id: buffer.assistantMessageID`, `agentId` из `turn?.agentId`. Для auto recorder tool-кадров не видит (они в `SessionFrameBufferService`, см. п.1).
14. **Buffer:** `session-frame-buffer.service.ts:17-35` — `push(type,data)` → `pushFrame({id: Bun.randomUUIDv7(), type, data})`; `pushIdle`. `session-stream.service.ts:59` `toStreamFrame`, `:82` `streamEvents` — `data` проходит passthrough (новые поля не теряются).

## 1. Матрица транспортов (C1, подтверждено)

| Режим | Transport | Tool-кадры | Durable сейчас |
|---|---|---|---|
| auto | InProcess → `runner.runTurn` → `publishFrame` → `SessionFrameBufferService` | только `tool-result`→`session.tool.success/failed` (без called/callID) | нет (текст) |
| ask + key | Direct → `bufferDirectLifecycle*` | фантомы `tool: agentId` | нет |
| ask без key | Host → host-бус → `AssistantRecorderService` | `session.tool.*` с `tool` (имя), callId неизвестен | нет |

Пять причин из PLAN.md подтверждаются; добавлено: **(6) runner не публикует `tool-call`** (п.0.1).

**C1 артефакт:** записка `.plans/chat-linked-nodes-l7/C1-diagnosis.md` с таблицей выше и e2e-наблюдением «2 вызова одного инструмента → 1 строка» (`useChat.ts:781` `toolCalled.has(toolName)`).

## 2. Карточки

### C1 — Диагностика
- **Checklist:** 1) зафиксировать матрицу (п.1); 2) вручную проверить в auto-сессии с двумя вызовами одного инструмента: в `useChat` одна строка; 3) подтвердить п.0.1 логом (`publish` в runner) — без правок кода.
- **Acceptance:** записка содержит 6 причин с file:line; ревью пройден.
- **Rollback:** не применимо (нет кода).
- **Gate:** нет.

### C2 — Схема БД (`session_messages`)

**Миграция `apps/backend/drizzle/0009_session_entries.sql`** (идемпотентна, `IF NOT EXISTS`/guard):

```sql
ALTER TABLE "session_messages" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'message';
ALTER TABLE "session_messages" ADD COLUMN IF NOT EXISTS "parent_id" text;
ALTER TABLE "session_messages" ADD COLUMN IF NOT EXISTS "prompt_id" text;
ALTER TABLE "session_messages" ADD COLUMN IF NOT EXISTS "payload" jsonb;
ALTER TABLE "session_messages" ADD COLUMN IF NOT EXISTS "seq" bigint;
ALTER TABLE "session_messages" ALTER COLUMN "text" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS "session_messages_session_seq_idx" ON "session_messages" ("session_id", "seq");
CREATE INDEX IF NOT EXISTS "session_messages_session_prompt_idx" ON "session_messages" ("session_id", "prompt_id");
-- backfill (отдельный шаг, идемпотентный: WHERE seq IS NULL)
UPDATE "session_messages" m SET "seq" = r.rn
FROM (SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY created_at, id) AS rn FROM "session_messages") r
WHERE m.id = r.id AND m.seq IS NULL;
UPDATE "session_messages" SET "prompt_id" = "id" WHERE "role" = 'user' AND "prompt_id" IS NULL;
-- assistant → ближайший предыдущий user той же сессии
UPDATE "session_messages" a SET "prompt_id" = (
  SELECT u.id FROM "session_messages" u
  WHERE u.session_id = a.session_id AND u.role = 'user' AND u.created_at <= a.created_at
  ORDER BY u.created_at DESC LIMIT 1)
WHERE a.role = 'assistant' AND a.prompt_id IS NULL;
```

Колонки (`schema.ts` `sessionMessages`, добавить): `kind: text('kind').notNull().default('message')`, `parentId: text('parent_id')`, `promptId: text('prompt_id')`, `payload: jsonb('payload')`, `seq: bigint('seq', {mode:'number'})`, `text: text('text')` (убрать `.notNull()`). Индексы в `(t) => [...]` добавить два новых, старый `session_messages_session_idx` оставить.

- **Старые строки:** `kind='message'`, `role` сохраняется (`user|assistant`), `payload` NULL. Валидность сохраняется за счёт DEFAULT.
- **Новые kind:** `message` (user/assistant текст), `tool-calling`, `reasoning`. Для user-узла `kind='message'`, `role='user'`. Значение `user` из контракта `SessionEntry` маппится на `kind='message' AND role='user'` (см. C3) — **решение:** в БД `kind` ∈ {`message`,`tool-calling`,`reasoning`}, а контрактный `user|agent-message` выводится из `role`. Это минимизирует миграцию.
- **Гейт:** `bun run db:check-integrity`; `bun run lint`; `bun run test` в `apps/backend`.
- **Spec:** `session-history.repository.spec.ts` — кейсы из Test matrix (T-DB-*).
- **Rollback:** миграция аддитивна. Откат SQL: `DROP INDEX IF EXISTS session_messages_session_seq_idx, session_messages_session_prompt_idx; ALTER TABLE session_messages DROP COLUMN kind, DROP COLUMN parent_id, DROP COLUMN prompt_id, DROP COLUMN payload, DROP COLUMN seq;` + `ALTER COLUMN text SET NOT NULL` **только если нет строк с NULL text** (проверка `SELECT count(*) WHERE text IS NULL`). Journal/snapshot откатываются коммитом.
- **Риск:** data/breaking (≈ medium/4). Миграция на заполненной БД — прогон на копии (`pg_dump` → restore → migrate).

### C3 — Контракт `SessionEntry`
- **Файлы:** `packages/contracts/src/sessions/sessions.ts`, `sessions.schema.ts`, `index.ts`, `contracts/openapi.yaml`.
- **Типы (после):**
```ts
type SessionEntryBase = { id: string; sessionId?: string; promptId: string | null; parentId: string | null; seq: number; createdAt: string };
type SessionEntry =
  | (SessionEntryBase & { kind: 'user'; text: string })
  | (SessionEntryBase & { kind: 'agent-message'; text: string; agentId?: string | null })
  | (SessionEntryBase & { kind: 'tool-calling'; tool: string; callId: string; status: 'called'|'success'|'failed'; input?: unknown; result?: string; error?: string })
  | (SessionEntryBase & { kind: 'reasoning'; text: string });
```
- **Zod:** `sessionEntrySchema = z.discriminatedUnion('kind', [...])` с `satisfies z.ZodType<SessionEntry>`; `sessionEntryListSchema = z.array(sessionEntrySchema)`.
- **Legacy:** `SessionMessage`, `sessionMessageSchema`, SSE-типы без изменений по полям; в tool-кадры добавить **опциональные** `entryId?`, `parentId?`, `promptId?`, `callId?` (аддитивно).
- **Wire-маппинг БД→контракт:** `kind='message' & role='user'` → `user`; `kind='message' & role='assistant'` → `agent-message`; остальные по `kind`. `seq` и `createdAt` — из БД.
- **OpenAPI:** новые схемы `SessionEntry`, `SessionEntryList` зеркально; `/messages` оставить как есть (legacy), новый параметр `?view=entries` (аддитивно) — см. Open Q.
- **Gate:** `bun run test` и `lint` в `packages/contracts`; `bun run build` (потребители).
- **Test matrix:** T-CT-* (parse по каждому kind; reject: `tool-calling` без `callId`; `status` вне enum; `kind` неизвестный; `seq` не int).
- **Acceptance:** `sessionEntrySchema.parse` принимает все 4 вида; старый `sessionMessageSchema` проходит без изменений.
- **Rollback:** аддитивно; удалить новые экспорты и `view=entries`.
- **Риск:** breaking/external (≈ medium/3). Потребители union-типа — `switch` без default (grep по `SessionMessage` в frontend).

### C4 — Backend: durable-канал узлов

**4a. Repository (`session-history.repository.ts`):**
- `appendEntry(row: {id, sessionId, projectId, userId, kind, role?, agentId?, text?, parentId?, promptId?, payload?, createdAt?}): Promise<{seq:number}>` — `seq` вычисляется в транзакции: `SELECT coalesce(max(seq),0)+1 FROM session_messages WHERE session_id=$1 FOR UPDATE` (или advisory lock по `sessionId`). Альтернатива — PG sequence (отклонено: глобальная, неудобна для per-session seq).
- `updateEntryStatus(id, {status, result?, error?, input?})`: читает `payload`, мерджит (`status`, `result`/`error` — **отфильтрованные**), пишет. Upsert `tool-calling` по `(sessionId, payload->>'callId')` — `findEntryByCallId(sessionId, callId)`.
- `listEntries(sessionId): Promise<Array<SessionEntryRow>>` — `orderBy(asc(seq), asc(createdAt))`, `deletedAt IS NULL`.
- `listMessages` — оставить (совместимая проекция), добавить фильтр `kind='message'` (п.0.4).
- Тип payload: `{ tool?: string; callId?: string; input?: unknown; status?: 'called'|'success'|'failed'; result?: string; error?: string }`.

**4b. TurnMeta:** `sessions.types.ts:41` добавить `promptId: string` (обязательное для нового кода; для host-turn — `receipt.id` либо синтетическое, см. Open Q). `in-process-turn.service.ts:109` → `setTurnMeta(sessionId, {userId, projectId, agentId, mode, promptId: receipt.id})`. `host-turn.service.ts:54` — аналогично (промпт-id из host-receipt).

**4c. Runner → tool-call фрейм:** `runner/runner.service.ts` перед `dispatch` (≈`:160-170`, где `keyed` сформирован) публиковать `publish({type:'tool-call', data:{callId: call.id, name: call.name, arguments: call.arguments}})` для каждого call (кроме `answerTool`, см. `pendingCalls` `loop.ts:~95`). `TurnFrame` (`loop.ts:80`) — тип уже `{type, data: Record}`, менять не надо.

**4d. InProcess (`in-process-turn.service.ts` `publishFrame` :228):**
- `tool-call` → `history.appendEntry({kind:'tool-calling', parentId: lastNodeId, promptId: meta.promptId, payload:{tool, callId, input: filter(arguments), status:'called'}})`; `this.buffer.push('session.tool.called', {sessionID, tool, callId, entryId, parentId, promptId})`.
- `tool-result` → `updateEntryStatus(callId, {status, result: filter(result)|error})` + `buffer.push('session.tool.success|failed', {sessionID, tool, callId, entryId, parentId, promptId, ...error})`. `callId = settlement.callID`.
- `lastNodeId` — локальный курсор в замыкании `runTurn` (или поле в `TurnMeta`): после каждого узла `parentId` = его id. Первый tool-узел хода: `parentId` = id `agent-message` предыдущего шага или user-узла.
- **Важно:** `publishFrame` сейчас синхронный (`void`), запись в БД — async. Решение: очередь промисов per-session (`chain = chain.then(...)`) с сохранением порядка, ошибки логируются, `tool-result` не блокирует runner.

**4e. Direct (`direct-turn.service.ts:131-145`, `file-command.turn.ts:181`):** маркеры `tool: agentId` **не** становятся узлами. Варианты: (а) оставить live-only фрейм с флагом `marker:true` и не писать в БД (default); (б) убрать `session.tool.*` и заменить на `session.reasoning.*` только. Default: (а) с явным `marker: 'lifecycle'`, фронт игнорирует при `marker`.

**4f. Recorder (`assistant-recorder.service.ts`):** host-путь: `session.tool.called/success/failed` из host-бус → тот же `repository.appendEntry/updateEntryStatus` (единая точка). Без `callId` → skip с `warn` (`[sessions] tool entry skipped code=no_call_id`), без синтетики по умолчанию (Open Q 2). Текст `appendMessage` остаётся для `agent-message`, но пишется через `appendEntry({kind:'message', role:'assistant', promptId})`.

**4g. Buffer/stream:** `session-frame-buffer.service.ts` и `session-stream.service.ts` — без изменений логики (passthrough `data`); проверить тест `sessions-stream.spec.ts`.

**4h. Fork (`sessions.service.ts` ~`:430-441`):** копировать `kind, payload, promptId, seq` (`seq` пересчитывается по порядку); карта `oldId→newId` для `parentId/promptId`. Revert (`revert.service.ts:58`) — оставить на `listMessages`.

**4i. Логи:** `AppLogger` пишет только `tool/status/callId/entryId`; `input/result` не логировать.

- **Gate:** `bun run lint`, `bun run test` (backend), `bun run db:check-integrity`, e2e `sessions.e2e.ts` (reload).
- **Spec/тесты:** см. Test matrix T-BE-*.
- **Acceptance:** auto-сессия с двумя вызовами `read` → в БД 2 строки `tool-calling` с разными `callId`, `seq` возрастает, `parentId` цепочка; после reload `GET` (entries) возвращает их; SSE содержит `callId/entryId`.
- **Rollback:** флаг (env `SESSIONS_ENTRIES_ENABLED`, default off на первом деплое) — при выключенном флаге пишется только текст (как сейчас). Откат кода — revert коммитов; данные `kind!='message'` безопасны для старого кода? **Нет**: старый `listMessages` без фильтра вернёт tool-строки с `text NULL` → нужен фильтр `kind='message'` в той же PR (уже в 4a). Поэтому фильтр — первым коммитом C4.
- **Риск:** high/15, risk high/6 (breaking, data, security). Митигации: п.6 в PLAN.md + фильтрация payload (Open Q 1).

### C5 — Frontend `useChat`: nodes + upsert

- **Типы:** `ChatNode = { id; kind: 'user'|'agent-message'|'tool-calling'|'reasoning'; promptId: string|null; parentId: string|null; seq: number; at: number; text?; tool?; callId?; status?; input?; result?; error? }`.
- **`toChatNodes(rows: SessionEntry[]): ChatNode[]`** — не дропать `tool-calling`, сорт по `seq`.
- **Live:** `session.tool.called|success|failed` → `upsertNode(callId | entryId)`. Удалить `toolCalled/toolDone: Set<string>` (`useChat.ts:507-520`, `:758-781`) — дедуп по имени уходит.
- **`streamingText`** → временный узел `kind:'agent-message'` с `id = assistantId` (не `newId()`), `finalize/failTurn/stop` (`:585`, `:628`) коммитят узел с тем же `assistantId`, который вернёт backend (`session.idle`/finish frame — добавить `entryId` в финальный фрейм).
- **`toolTrace: ChatToolEvent[]`** (`:481`) — оставить только для `auth/create-session/history/prompt`-служебных событий; tool/reasoning строки уходят в nodes.
- **`reload/resync/verifyStuckSending`:** заменяют `nodes` целиком из `GET`.
- **Транспорт:** `apps/frontend/src/api/sessions-client.ts`, `api/client.ts` — добавить `listEntries` (если выбран `view=entries`).
- **Тесты:** `useChat.test.tsx` — T-FE-*.
- **Gate:** `bun run lint`, `bun run test`, `bun run build` (frontend), `bun run check` (только diff).
- **Acceptance:** 2 вызова одного инструмента → 2 строки; после reload строки tool остаются; live обновляет существующую строку по callId.
- **Rollback:** фича-флаг `NEXT_PUBLIC_CHAT_NODES` — при off используется старый `messages+toolTrace` путь. Ветка остаётся в коде до приёмки волны 1, затем удаление старого пути отдельным коммитом.
- **Риск:** high/14, risk medium/5.

### C6 — `ChatThread` рендерит узлы
- `ChatThread.tsx:41-64` `buildThreadRows` заменить на `buildNodeRows(nodes)`: сорт по `seq`, без merge-by-`at`.
- `chat-thread/types.ts` — `ThreadRow` union: `{kind:'node', key: node.id, node}` + live-временные (thinking/streaming) в конце.
- `ChatToolRow` (`chat-tool-row/types.ts`): `event?: ChatToolEvent` → добавить проп `node?: ChatNode` (или расширить `ChatToolEvent`); отображать `tool/status/input/result` (сворачиваемо), текст как сейчас.
- `reasoning` → `ChatThinkingRow` (существующий).
- `onFork/onRevert` — id узла `user`/`agent-message` (не tool).
- i18n: ключи статусов (`called|success|failed`) в `apps/frontend/src/i18n/*`.
- **Тесты:** `chat-thread.test.tsx` — порядок `user→tool→tool→agent→agent` снапшотом; `chat-window.test.tsx` — без регрессий.
- **Acceptance:** в UI видно последовательность `сообщение → инструмент → инструмент → ответ → ответ` и после reload та же последовательность.
- **Rollback:** откат к `buildThreadRows` (сохранить старую функцию за флагом до приёмки).
- **Риск:** medium/9, risk low/2.

## 3. Порядок реализации волны 1 с чекпоинтами

| # | Шаг | Гейт (обязательно перед следующим) |
|---|---|---|
| 1 | C1 записка | ревью |
| 2 | C2 schema.ts + 0009 + journal/snapshot | `bun run db:check-integrity`; backend `test` (repository spec); миграция на копии БД (пустой + заполненной) |
| 3 | C3 contracts + openapi | `packages/contracts` `test` + `lint`; `build` потребителей; `check` |
| 4a | C4 фильтр `kind='message'` в `listMessages` (первым коммитом) | backend `test`; `sessions.e2e.ts` |
| 4b | C4 repository methods + TurnMeta.promptId | `session-history.repository.spec.ts` |
| 4c | C4 runner `tool-call` фрейм | `runner/__tests__/loop.spec.ts` + `in-process-turn.spec.ts` |
| 4d | C4 InProcess/Direct/Recorder/fork | `in-process-turn.spec.ts` (2 вызова → 2 узла), `sessions-stream.spec.ts`, `sessions.e2e.ts` reload |
| 5 | C5 useChat nodes (за флагом) | `useChat.test.tsx`, `lint`, `build` frontend |
| 6 | C6 ChatThread (за флагом) | `chat-thread.test.tsx`, `chat-window.test.tsx`, `check` |
| — | Приёмка волны 1 | ручной e2e: auto с 2 вызовами одного инструмента + reload; ask+key и ask без key; `bun run check` |

Команды (из корня, без raw tsc/eslint): `bun run lint:affected`, `bun run test:affected`, `bun run build:affected`, `bun run check` (skill check), `cd apps/backend && bun run db:check-integrity`.

## 4. Acceptance criteria (волна 1, пользовательские)

- AC-1: auto-сессия, два вызова `read` подряд → в чате две отдельные строки инструмента, между ними порядок сохранён.
- AC-2: после reload страницы те же строки инструментов на месте, в том же порядке.
- AC-3: `user → tool → tool → agent-message → agent-message` отображается в этом порядке (`seq`).
- AC-4: ask-режим (direct) не показывает фантомных строк с именем агента.
- AC-5: старые сессии (только текст) открываются без ошибок, текст не изменился.
- AC-6: `GET /api/v1/sessions/{id}/messages` (legacy) ответ идентичен до миграции (только `kind='message'`).
- AC-7: в логах нет тел `input/result`.

## 5. Rollback (сводно)

- Миграция 0009: аддитивна; откат SQL в C2 (только если все `text` не NULL). Предпочтительно: оставить колонки, откатить код.
- Фича-флаги: `SESSIONS_ENTRIES_ENABLED` (backend, default off до приёмки), `NEXT_PUBLIC_CHAT_NODES` (frontend).
- Код: revert по карточкам в обратном порядке C6→C5→C4→C3; C2 откатывать последним.
- Данные: строки `kind!='message'` игнорируются старым кодом только благодаря фильтру из C4a — поэтому C4a выкатывается первым.

## 6. Test matrix

| ID | Уровень | Файл | Кейс | Ожидание |
|---|---|---|---|---|
| T-DB-1 | backend spec | session-history.repository.spec.ts | appendMessage старого вида → kind='message', seq растёт | seq=1,2… |
| T-DB-2 | backend spec | то же | appendEntry tool-calling с payload.callId | строка с kind/payload |
| T-DB-3 | backend spec | то же | updateEntryStatus по callId (called→success) | одна строка, status=success |
| T-DB-4 | backend spec | то же | два вызова одного tool с разными callId | 2 строки |
| T-DB-5 | backend spec | то же | listMessages не возвращает tool-строки | только message |
| T-DB-6 | backend spec | то же | listEntries порядок по seq | возрастание |
| T-DB-7 | backend spec | то же | fork копирует kind/payload/promptId, новые id | parentId переназначен |
| T-DB-8 | integrity | db:check-integrity | после 0009 | зелёный |
| T-DB-9 | migration | ручной | пустая БД и БД с данными (backfill) | seq/prompt_id заполнены, assistant.prompt_id = ближайший user |
| T-CT-1 | contracts | sessions.schema.spec | parse user/agent-message/tool-calling/reasoning | ok |
| T-CT-2 | contracts | то же | tool-calling без callId | reject |
| T-CT-3 | contracts | то же | status вне enum | reject |
| T-CT-4 | contracts | то же | неизвестный kind | reject |
| T-CT-5 | contracts | то же | legacy sessionMessageSchema | ok (без изменений) |
| T-BE-1 | backend spec | in-process-turn.spec.ts | 2 вызова одного инструмента → 2 узла, parentId цепочка | 2 |
| T-BE-2 | backend spec | то же | tool-result error: → status failed, error записан | failed |
| T-BE-3 | backend spec | то же | tool-result не блокирует runner при ошибке записи | runner завершён, лог warn |
| T-BE-4 | backend spec | direct-turn spec | маркер tool:agentId не создаёт узел | 0 tool-узлов |
| T-BE-5 | backend spec | assistant-recorder spec | host tool-кадр без callId → skip+warn | 0 узлов |
| T-BE-6 | backend spec | runner loop.spec.ts | tool-call фрейм на каждый call, без answerTool | N фреймов |
| T-BE-7 | backend spec | sessions-stream.spec.ts | SSE tool-кадр содержит callId/entryId/parentId/promptId | есть |
| T-BE-8 | e2e | sessions.e2e.ts | reload: GET entries возвращает tool-узлы | совпадает |
| T-BE-9 | backend spec | logger | input/result не в логах | нет |
| T-FE-1 | hook test | useChat.test.tsx | durable tool-узел рендерится | есть |
| T-FE-2 | hook test | то же | live session.tool.success обновляет существующий узел по callId | 1 узел |
| T-FE-3 | hook test | то же | reload сохраняет порядок seq | порядок |
| T-FE-4 | hook test | то же | 2 вызова одного инструмента = 2 узла | 2 |
| T-FE-5 | hook test | то же | finalize коммитит узел с assistantId (не newId) | id совпадает с backend |
| T-FE-6 | component | chat-thread.test.tsx | порядок user→tool→tool→agent→agent | снапшот |
| T-FE-7 | component | ChatToolRow test | статусы called/success/failed | корректный текст |
| T-GD-1 | guard | no-opencode-transport | после изменений | зелёный |

## 7. Open questions with defaults

1. **Payload-фильтрация секретов/PII.** Default: `input` и `result` проходят через `sanitizeToolPayload(value)`: (а) строки обрезаются до 4 КБ (`…[truncated]`); (б) ключи, совпадающие с `/(token|secret|password|key|authorization|cookie)/i`, заменяются на `"[redacted]"`; (в) `result` сохраняется только для инструментов из allowlist (read/list/grep по умолчанию; write/bash — только `status` и длина). Логи — без тел (T-BE-9).
2. **callId в host-пути.** Default: если host-кадр не несёт `callId`, узел **не создаётся** (skip + warn, T-BE-5), а UI показывает live-строку без durable-узла. Синтетика `toolName+step` отклонена: ломает upsert-ключ и даёт фантомы при повторе. Если host в будущем отдаёт id — добавить в контракт host-бус, не в БД.
3. **fork/revert копирование полей.** Default: fork копирует `kind, payload, promptId`, `seq` пересчитывается, `parentId/promptId` переназначаются по карте old→new (T-DB-7). Revert не меняется: позиционирование через `listMessages` с фильтром `kind='message'` (п.0.4); tool-узлы удаляются вместе с родительским промптом (через `promptId`) — это новое поведение, зафиксировать в ADR (C8).
4. **Номер миграции** — `0009` (последняя `0008_vault_secrets.sql`, подтверждено).
5. **Endpoint списка узлов.** Default: `GET /api/v1/sessions/{id}/messages?view=entries` (аддитивно), legacy без параметра — проекция `kind='message'`. Альтернатива `GET .../entries` — отложена до C7.
6. **promptId для host-turn.** Default: `receipt.id` host-receipt, если он есть; иначе генерируется в host-turn.service до `setTurnMeta`.
7. **Фича-флаги.** Default: оба флага выключены по умолчанию; включаются после приёмки волны 1.

## 8. Риски и митигации по карточкам

| Карточка | Риск | Митигация |
|---|---|---|
| C1 | Неполная картина host-путя (нет данных о callId) | Записка + один ручной прогон host-режима |
| C2 | Миграция на большой таблице (backfill `UPDATE` с подзапросом) | Батчи по session_id; индексы созданы до backfill; прогон на копии; `CREATE INDEX CONCURRENTLY` если таблица большая (вне транзакции миграции) |
| C2 | `text DROP NOT NULL` ломает потребителей, ожидающих string | Контракт `text: string|null` уже допускает null (`sessionMessageSchema:138`) |
| C2 | Откат невозможен, если появились NULL text | Откат кода вместо отката схемы |
| C3 | Breaking union у потребителей (`switch` без default) | grep по `SessionEntry`/`SessionMessage` перед слиянием; аддитивно |
| C4 | Порядок записи async в sync `publishFrame` | Per-session promise chain; тест T-BE-3 |
| C4 | `seq` гонки при параллельных записях | `FOR UPDATE`/advisory lock по sessionId в транзакции |
| C4 | Утечка секретов в payload/логах | Open Q 1 default + T-BE-9 |
| C4 | Revert видит tool-строки | Фильтр `kind='message'` в `listMessages` первым коммитом |
| C4 | Фантомы direct | Маркеры не пишутся в БД (4e), T-BE-4 |
| C5 | Регрессия watchdog/finalize | Сохранить SSE-цикл; флаг `NEXT_PUBLIC_CHAT_NODES`; T-FE-5 |
| C5 | Расхождение id live/durable | Backend возвращает `assistantId`/`entryId` в финальном фрейме |
| C6 | Регрессия `onFork/onRevert` | id узла user/agent сохраняется; снапшот |
| C6 | Визуальная регрессия thinking/streaming | Временные узлы только в конце списка |

## 9. Итог для исполнителя

Порядок коммитов волны 1: C1 записка → C2 (schema + 0009 + journal/snapshot) → C3 (contracts + openapi) → C4a (фильтр kind) → C4b (repository + TurnMeta.promptId) → C4c (runner tool-call) → C4d (InProcess/Direct/Recorder/fork) → C5 (useChat за флагом) → C6 (ChatThread за флагом) → приёмка AC-1…AC-7. C7/C8 — после приёмки волны 1.
