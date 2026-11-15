# План: фикс стриминга ИИ + выбор модели в чате (ветка feat/cli-cloud-chat)

## Фаза 1 — Диагностика стриминга
Файлы-кандидаты:
- `apps/frontend/src/hooks/useChat.ts` (редьюсер кадров: `message.part.delta` append `data.delta`, `message.part.updated` snapshot, `session.idle` финализация streamingText→messages, scope `frame.session` vs активный sessionId; бэкофф 1s→15s, AbortController)
- `apps/frontend/src/api/sessions-client.ts` (`sessionEventStream`/`streamSessionEvents`, SSE исключение без JSON-буферизации), `apps/frontend/src/hooks/useSessionEvents.ts`, `useSessionMessages.ts`
- `apps/backend/src/sessions/sessions.service.ts` (трансляция upstream v2 frames), `apps/backend/src/common/sse-relay.ts` (механика SSE, обрыв downstream → тихо в debug), `apps/backend/src/sessions/sessions.controller.ts`
- `packages/contracts/src/sessions/sessions.ts` + `sessions.schema.ts` (`SessionStreamFrame`, `SessionRunStatus`), upstream-эталон `contracts/opencode-stand-2.2.0.json`
Критерии готовности: таблица «upstream frame → бэкенд frame → фронт-действие» для delta/updated/idle; найден конкретный потерянный переход (scope? finalize? парсинг zod?); воспроизводится локально.
Риски: upstream v2 shape дрейфует от эталона; SSE-обрывы маскируются под «сломан»; пустое тело режется SDK (`stripEmptySlots`) — диагностировать через `fetchWithRetry`.

## Фаза 2 — Фикс стриминга
Файлы: те же + `apps/frontend/src/hooks/__tests__/`.
Что сделать: scope кадров по `frame.session` (чужие игнор); delta — append; updated — snapshot-замена; idle — flush `streamingText` в `messages` + `loading=false`; `text:null` скип (уже есть в `toChatMessages`); бэкофф/Abort сохранить; логи только `AppLogger`-стиль на бэке, без стеков/секретов в normal path.
Критерии: ассистентский ответ достримовывается целиком, повторные промпты не смешиваются между сессиями, `stop()`/`reload()` корректны.
Риски: двойной flush (delta+updated) → дедуп по part/message id; кросс-ток при смене sessionId.

## Фаза 3 — Контракт модели (YAML + package + бэкенд-проброс)
Файлы: `contracts/openapi.yaml` (components/schemas: `CreateSessionRequest`, `SendMessageRequest` + переиспользовать `SessionInfoModel{id,providerID,variant?}` как `ModelRef`), `packages/contracts/src/sessions/sessions.ts` + `sessions.schema.ts` (zod, поле-в-поле с YAML), `apps/backend/src/sessions/sessions.dto.ts` + `sessions.service.ts` (проброс `model` в upstream `create`/`prompt`), `apps/backend/src/sessions/sessions.e2e.ts`.
Что сделать: добавить optional `model?: {providerID,id,variant?}` в оба запроса; бэкенд пробрасывает как есть (null = серверный дефолт upstream, без выдумывания дефолта — запрет фолбэков); обход SDK-резки ключей через `fetchWithRetry` + `serveBasicAuthHeader` с непустым телом (прецедент `title`/`parentID`); ошибки upstream не маскировать (400/422→EXTERNAL_BAD_REQUEST, 404→EXTERNAL_NOT_FOUND, сбой→503+Retry-After:30).
Критерии: YAML↔package идентичны; e2e create+send с model проходят; без model поведение прежнее.
Риски: расхождение YAML↔package (баг пакета); SDK молча режет ключ — только raw fetch путь; deprecated `/api/opencode/*` не трогать (Forward-Only).

## Фаза 4 — UI выбора модели в чате
Файлы: `apps/frontend/src/hooks/useChat.ts` (`send(text, opts?: {model})`, createSession с model), `apps/frontend/src/api/sessions-client.ts` (`createSession`, `sendSessionMessage` + model), компонент чата (селектор provider→model поверх доменного `GET /api/sessions/providers`; НЕ `/api/opencode/config/providers` — currently deprecated TODO card 6, переключать на доменный), `src/hooks/query-keys.ts` (ключ списка провайдеров), `src/hooks/useAiProviders.ts` (перевести на доменный при касании).
Что сделать: селектор в шапке/панели чата, персист выбора (стор или локальный стейт), placeholder/disabled пока модели грузятся; формат ошибок через `format-error` + `t` в `useMemo`, `queryFn` бросает raw `ApiClientError`.
Критерии: выбор уходит в create/prompt, смена модели между сообщениями работает, guard-тест зелёный (нет `@opencode-ai/sdk`, нет `/api/opencode/*` даже в комментах), `app/` остаётся тонкой композицией.
Риски: `useAiProviders` сейчас на deprecated-алиасе — scope-крип (переключить попутно или зафиксировать TODO); guard-тест ловит даже комментарии.

## Фаза 5 — Тесты и гейты
- Юнит: редьюсер кадров useChat (delta-append, updated-snapshot, idle-flush, чужой session игнор); zod-парсинг новых полей контракта.
- Бэкенд e2e (`sessions.e2e.ts`): create/send с model + без model; скан секретов/форм как в `opencode-keys.e2e.ts` (перехват AppLogger, assert без `\n` в warn/error).
- Гейты: `bun run lint` (tsc --noEmit + biome), `bun run build` (фронт `next build --turbopack`); точечно `lint:affected`/`build:affected`.
- Guard: `no-opencode-transport.test.ts` обязан быть зелёным.
Риски: Next.js-блок в `apps/frontend/AGENTS.md` — писать код только после чтения `node_modules/next/dist/docs/`; mobile не трогать (standalone npm).
