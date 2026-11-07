# PLAN — Нет стрима инструментов (silent-stream-k7)

Ветка: `feat/cli-cloud-chat`. Корень: `/media/codebase/@web2bizz/devbox`.
Target state: при auto-создании файла в чате виден прогресс (тулзы/статусы) + финальный текст-ответ коммитится в messages; пустой тред только до первого кадра.
SSE-контракт расширять только аддитивно. Фронт-канон `apps/frontend/AGENTS.md` соблюдать. Только план — кода в этих карточках нет, исполнение отдельно.

## Диагноз (из epoch-02, доказано код-ридингом)

1. `apps/frontend/src/hooks/useChat.ts:124-181 frameText` — маппит только `session.text.delta/ended`, `session.execution.succeeded`, `session.step.ended`, legacy `message.part.*`, `session.idle`; host-типы `session.tool.called/progress/success/failed`, `session.tool.input.*`, `session.reasoning.*` → `null → continue` (:481) без следа.
2. `apps/frontend/src/hooks/useChat.ts:193-204 frameToolName` — только `message.part.updated` + поля `tool/toolName/name`; `session.tool.*` никогда не дают `activeToolName` → `chat-window.tsx` thinking/streaming статусы + `chat-tools-timeline.tsx` live-строка молчат.
3. `useChat.ts:491-506 pushTrace` — trace только `session.text.delta/ended`, `execution.succeeded/step.ended`, connect/prompt/auth/history/interrupt/reload; tool-переходов нет → timeline — псевдо-trace из 2-3 строк, при `events.length===0 && !liveToolName` вообще `return null`.
4. Бэк `session-harness.service.ts:975-991 toStreamFrame` — passthrough, `1003-1195 streamEvents` — `?session=` сужает, unknown/foreign → quiet empty stream, `filterFrame` режет по `localSessionIds`; `recordHostEvent:846-910` пишет в durable только текст — подозреваемый №2, различить только рантайм-логом.
5. Контракт `packages/contracts/src/sessions/sessions.schema.ts:148-201` — envelope permissive (`type: string`), narrowed только `message.part.*` + `stream.error`; tool-схем нет — прецедент guarded reads (`frame.data as`) уже есть в frameText.

## Карточки (строго diag → fix → verify)

### D1 — DIAG: доказать где дропаются host-кадры [complexity: low | риск: low]

Файлы:
- `apps/frontend/src/hooks/useChat.ts` (SSE-цикл :439-568, точки :459/:461/:471/:480-481)
- `apps/frontend/src/api/sessions-client.ts` (:202-292, `skipped`-счётчик)
- `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` (`streamEvents` :1019-1035 `?session=`, `filterFrame` :1180-1193, `mapFrame` :1194)
- Опционально `packages/contracts/src/sessions/sessions.schema.ts` (сверить envelope)

Чек-лист:
- [ ] Временный debug: лог сырых `frame.type` ДО `frame.session !== sid` фильтра (только type+session-match, без data-тел, без секретов; фронт — console.debug за флагом, бэк — AppLogger.debug однострочник).
- [ ] Залогировать ветки: `abortedTurnRef-drop`, `foreign-session-drop (?session=/resolve)`, `frameText-null-drop`, `safeParse-skip` (sessions-client `skipped` с типом чанка).
- [ ] Один auto-прогон «создай файл»: записать полный список типов + порядок + какой терминатор пришёл (`text.ended` vs `step.ended` vs `execution.succeeded`), дошёл ли POST `sendSessionMessage` до стрима или упал по таймауту.
- [ ] Зафиксировать точные tool-payload поля (`tool vs toolName vs name`, где `input/progress/result`, есть ли `sessionID/assistantMessageID`) для F2-guards.
- [ ] Diag-вывод: таблица тип → дошёл до фронта? → прошёл фильтр? → спроецировался? + вердикт «виноват фронт-проекция / бэк-фильтр / оба / терминатор».
- [ ] Временный лог удалить или заглушить флагом до конца D1 (не тащить в F2).

Done D1: есть лог одного auto-прогона со списком host-типов, видно на какой строке дроп, вердикт записан, временный лог убран/зафлаген.

---

### F2 — FIX: спроецировать tool-прогресс + сохранить чистый финал [complexity: medium | риск: medium (факторы: breaking-SSE-проекция, data-смешение)]

Файлы:
- `apps/frontend/src/hooks/useChat.ts` (`frameToolName` :193-204, `frameText` :124-181, SSE-цикл :472-506, `append` :333-336, `finalize` :341-353, `ChatToolEvent` kind :34-40, `traceFlagsRef` :295-298)
- `apps/frontend/src/components/chat/chat-window/chat-tools-timeline.tsx` (без переделки структуры, только новые label/detail)
- `apps/frontend/src/components/chat/chat-window/agent-thinking.tsx` + `chat-window.tsx` (сигнал уже есть — проверить, без новой вёрстки/hex)
- Опционально `packages/contracts/src/sessions/sessions.schema.ts` + `contracts/openapi.yaml` (только если D1 решит, что нужны narrowed tool-схемы; зеркально + тесты) + `apps/frontend/src/api/sessions-client.ts` (без смены fail-soft)

Чек-лист:
- [ ] `frameToolName`: добавить `session.tool.called/progress/success/failed` (+ `session.tool.input.*` как detail-источник) с guarded reads всех трёх ключей (`tool/toolName/name`), `type==='text'`-исключение сохранить; reasoning-типы — НЕ tool (в detail/debug, не в activeToolName).
- [ ] Tool-кадры не пускать в text-тракт: в SSE-цикле после `frameToolName` — `setActiveToolName` + per-turn once-trace (`tool.called → success/failed`, progress — throttle/once, не per-frame), затем `continue` мимо `frameText/append` (tool-текст НИКОГДА в `streamingRef/streamingText`).
- [ ] `ChatToolEvent kind` расширить аддитивно (`'tool'` или узкие `'tool-called'/'tool-progress'/'tool-done'` — одно решение, везде одинаково), `traceFlagsRef` + флаг tool-перехода (once-per-turn).
- [ ] Терминатор не менять: `finalize` по-прежнему `text.ended/step.ended/execution.succeeded`; проверить что tool-кадры не сбрасывают `partLens`/`streamingRef`; `stop()`/abort/interrupt-семантику не трогать.
- [ ] Timeline/agent-thinking без новой вёрстки: kit-only, token-классы, hex-запрет; `liveToolName` теперь реально приходит; пустой тред до первого кадра — `thinking`-ротация, после — статусы.
- [ ] Канон: `useEffect`-исключение с комментом-обоснованием сохранить/обновить, слои не смешивать (проекция в `useChat`, рендер в components, fetch только через `client.ts`/`sessions-client.ts`), guard `no-opencode-transport` не задет.
- [ ] Контракт-аддитивность: envelope не сужать; новые типы — опциональные схемы + `safeParse`, старые кадры парсятся как раньше; секреты из data не логировать.

Done F2: auto-прогон показывает `activeToolName` + tool-переходы в timeline, reasoning не смешивается с ответом, финальный текст коммитится в messages как раньше, `bun run lint` + `next build --turbopack` зелёные, guard-тест зелёный.

---

### V3 — VERIFY: auto-сценарий + регресс [complexity: low | риск: low]

Файлы:
- Ручной прогон на `feat/cli-cloud-chat` (создание файла через auto) + `apps/frontend/src/components/chat/chat-window/chat-window.tsx` (ассёрты рендера) + lint/build-логи.

Чек-лист:
- [ ] Сценарий: новый чат → auto-промпт «создай файл» → наблюдать: thinking-строка сразу (не EmptyState), затем live tool-имена, затем streaming-текст, затем assistant-row в messages; файл на диске создан.
- [ ] Ассёрты: timeline-событий больше псевдо-минимума (есть tool-переходы), `chat-tool-live`/`chat-active-tool` видны во время turn, после коммита `sending=false`, `streamingText` очищен, тред не пуст.
- [ ] Негатив: F5 mid-turn догоняет (accumulate regardless of sending), `stop()` коммитит partial + глушит поздние кадры, `?session=` чужой сессии по-прежнему quiet-empty (без утечки), битый SSE-чанк не роняет стрим.
- [ ] Регресс: `bun run lint` (tsc --noEmit + biome), `bun run build` (next --turbopack), guard `no-opencode-transport.test.ts`, текстовый чат без тулзов работает как раньше (delta→ended→commit).
- [ ] Пустой тред виден только до первого кадра — после первого tool/text кадра EmptyState не возвращается.

Done V3 (финальный done плана): критерии постановки выполнены — прогресс виден + финальный ответ в messages + пустой тред только до первого кадра; регресс-гейты зелёные; diag-лог убран; решение о narrowed tool-схемах зафиксировано (добавлены зеркально или отвергнуты с причиной).

## Порядок и зависимости

D1 → F2 → V3, строго последовательно. F2 не начинать без D1-вердикта и списка tool-полей (иначе guards угаданы). V3 не начинать без F2-done.

## Что НЕ делать (non-negotiable)

- Не сужать SSE-envelope enumом; не ломать fail-soft парсер; не писать tool-кадры в durable историю (`recordHostEvent` persist не трогать); не тащить tool-текст/reasoning в `streamingText`; не переносить `useChat` на React Query; не импортить `@opencode-ai/sdk` / `/api/opencode/*` даже в комментариях; не вводить hex/кастом-стили мимо kit.

## Complexity / риск сводно

| Карточка | Complexity | Риск | Митигация |
|---|---|---|---|
| D1 diag | low (3-4 файла, только debug-логи) | low | без data-тел, временный код удалить |
| F2 fix | medium (проекция + trace + опционально контракт) | medium (смешение tool-текста в ответ, ломка SSE) | tool мимо append, safeParse, аддитивность, lint/build/guard |
| V3 verify | low (прогон + гейты) | low | symptom-anchored ассёрты, негатив-кейсы |
