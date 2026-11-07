# Epoch 2: Evidence gathering

## Hypothesis
Узкие места подтверждаются чтением исходников; план ляжет на реальные строки и паттерны.

## Evidence Found
- File: `apps/backend/src/common/sse/sse-relay.ts` — heartbeat **отсутствует**: только `data:` кадры (`res.write data: ...\n\n`), есть `mapFrame/filterFrame`, `droppedByFilter` счётчик, `STREAM` без ping. Прокси с idle-timeout убьёт сокет. `filterFrame` уже есть (используется harness) — точка для `?session=`.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts:1056-1128` — replay = `frames.filter(localSessionIds)` + `cursor=frames.length` + live-merge с `POLL_MS=250`, `LOCAL_IDLE_MS=30s`, `STREAM_CAP_MS=300s`. **Курсора/Last-Event-ID нет**: replay отдаёт всё локальное с нуля при каждом коннекте (дубли после redial), id кадров — runner-ские, монотонность не гарантирована транспортом.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts:1129-1144` — `filterFrame` дропает чужие сессии по `frame.session ∈ localSessionIds`, `mapFrame=toStreamFrame` (re-key `data.sessionID→session`). Серверный фильтр есть, но **без `?session=`**: каждый клиент получает мультиплекс всех своих сессий и фильтрует в памяти.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/sessions.controller.ts:296-311` — `GET events` принимает только `?projectId`, пробрасывает в `sessions.service.streamEvents→harness.streamEvents`. `?session=` отсутствует в контроллере/сервисе/ openapi.
- File: `apps/frontend/src/api/sessions-client.ts:194-255 sessionEventStream` — **FAIL LOUD**: `JSON.parse` без try + `sessionStreamFrameSchema.parse` (throw) → один битый кадр убивает весь генератор → `useChat` ловит как stream break + `setError` на весь тред. Heartbeat-комменты скипаются (`data:`-линии отсутствуют → continue) — точка для watchdog. `Last-Event-ID` не отправляется, `?session=` не строится.
- File: `apps/frontend/src/api/client.ts:324-354 streamSessionEvents` — SSE-исключение (открытый Response, без timeout), URL только `?projectId`. Точка вставки `?session=` + `Last-Event-ID` header.
- File: `apps/frontend/src/hooks/useChat.ts:305-459` — SSE-loop: `if (!sendingRef.current) continue` **до** проверки session (подписка глушится вне turn — чужой/поздний ответ не подхватится после F5), ошибка транспорта → `setError` (весь тред заменяется ErrorState в `chat-window`), backoff 1s→15s есть, `attemptRef` есть, но **watchdog нет**, `online/visibilitychange` resync нет, `sending` висит если `session.idle/step.ended` потерян (нет страховки через REST/status).
- File: `apps/frontend/src/features/chat/chat-section.tsx` — тонкая сборка `useChat({sessionId, projectId})`, без URL-синка. File: `apps/frontend/src/components/chat/chat-window/chat-window.tsx:107-113` — `if (error)` **заменяет весь тред** на ErrorState (транзиент = потеря контекста). File: `app/organizations/[orgId]/projects/[projectId]/sessions/[sessionId]/page.tsx` — sessionId из path-params, `agentId` нигде не persists.
- Pattern: граница строго zod (`parseBoundary`, `safeParse` для delta/updated в `frameText`), `withAuth` single-flight refresh, C4 project-gate 400/404, логи только `AppLogger`, тесты в `__tests__` рядом с кодом.

## Decisions
- Decision: 7 карточек C0–C6, порядок root→branch→leaf (heartbeat+error-кадр первые — на них завязан watchdog и fail-soft контракт).
- Alternatives considered: один большой PR — rejected (риск отката всего стрима, Trello требует атомарности).
- Rationale: evidence показывает 4 независимые точки отказа (транспорт, буфер, клиент-парсинг, хук-гард) + 2 политики (URL, ErrorState) — каждая тестируется отдельно.

## Confirmed Plan Items
1. C0 heartbeat + терминальный error-кадр в `sse-relay` + контракт — reason: без ping прокси рвёт сокет, без error-кадра обрыв неотличим от idle.
2. C1 курсор/Last-Event-ID в replay-буфере — reason: redial сейчас или дублирует всё, или теряет середину.
3. C2 `?session=` фильтр в `GET /events` — reason: чужие сессии будят чужой стрим.
4. C3 транспорт fail-soft + watchdog-заготовка — reason: битый кадр не должен убивать тред.
5. C4 `useChat` self-healing (resync, sending-гард) — reason: F5/обрыв без потери треда и без вечного sending.
6. C5 persist sessionId+agentId в URL — reason: F5 продолжает тот же sessionId.
7. C6 политика ErrorState + приёмка — reason: транзиент ≠ терминал.

## Open Questions
- Формат id кадров harness (`localFrames`): монотонны ли? Нужен ли серверный seq поверх runner id?
- Имя терминального кадра: `stream.error` vs `session.error` vs `error`? Совместимость с `sessionStreamFrameSchema` (type: string — любое ок, но нужен narrow-контракт?).
- Где канонический URL после создания сессии: push `sessions/[sessionId]` + `?agent=` или path только?

## Next Epoch Focus
- Decision foundation: зафиксировать контрактные решения (имена, query-параметры, header), разрешить конфликты (droppedByFilter vs ?session=, sending-гард vs подписка).
