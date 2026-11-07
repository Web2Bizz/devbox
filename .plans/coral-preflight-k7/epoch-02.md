# Epoch 2: Evidence gathering + Decision foundation

## Hypothesis
- Epoch-01 гипотеза верна: список `allowedHeaders` неполон, фронт и harness уже согласованы по `Last-Event-ID`.

## Evidence Found
- File: `apps/backend/src/app/app.setup.ts:55-82` — `app.enableCors({ origin: allowlist-callback, methods: [GET,POST,PATCH,PUT,DELETE,OPTIONS], allowedHeaders: ['content-type','x-correlation-id','x-user-id','authorization'], exposedHeaders: ['x-correlation-id'], credentials: true })`. `last-event-id` отсутствует. Регистр списка — нижний; Express/cors матчит headers case-insensitive, но стиль — lowercase.
- File: `apps/frontend/src/api/client.ts:324-357` (`streamSessionEvents`) — `fetch GET /api/v1/sessions/events?projectId=&session=` с headers `accept: text/event-stream`, `authorization: Bearer`, `x-correlation-id`, опционально `'Last-Event-ID': opts.lastEventId` (строка 340).
- File: `apps/backend/src/processes/modules/ai/modules/sessions/sessions.controller.ts:311` — `@Headers('last-event-id') lastEventId?: string`, коммент «`?session=/?cursor=/Last-Event-ID` ride the raw request into the harness».
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts:1022-1025` — `const headerCursorRaw = req.headers?.['last-event-id']` (`Last-Event-ID` first, `?cursor=` fallback).
- File: `apps/backend/src/common/sse/sse-relay.ts:19,160` + `__tests__/sse-relay.spec.ts:266` — SSE `id:` для `Last-Event-ID` redial.
- Pattern: CORS-тестов нет — grep `allowedHeaders|Access-Control-Allow-Headers|last-event-id` по `apps/backend` не нашёл ни одного `*.spec.ts/*.e2e.ts` на preflight; grep `enableCors|cors` нашёл только `app.setup.ts`, `main.ts:78 (cors:false)`, `common/env/env.ts` (origins). Существующие `sessions-stream.spec.ts:227-292` покрывают cursor-логику (`headers: {'last-event-id': ...}`), но не preflight.
- Pattern: проверки по AGENTS.md — backend `bun run lint` (`tsc --noEmit` + `biome`), frontend трогать не надо.

## Decisions
- Decision: добавить `'last-event-id'` (lowercase, в конец списка) в `allowedHeaders` в `app.setup.ts:71-76`. Одна строка, стиль списка сохранить.
- Alternatives considered: `'*'` wildcard — rejected (ломается с `credentials:true`); верхний регистр `'Last-Event-ID'` — допустим (case-insensitive), но rejected ради консистентности списка (весь lowercase).
- Rationale: минимальный diff, чинит именно preflight, не меняет origins/methods/credentials/exposedHeaders.

## Confirmed Plan Items
1. Правка `app.setup.ts:71-76` — добавить `last-event-id` — reason: закрывает ошибку preflight; artifact: изменённый массив; validation: `rg allowedHeaders` показывает 5 entries.
2. Ручная проверка preflight (curl OPTIONS) + GET events с header — reason: CORS-тестов в репо нет, авто-покрытие не требуется для точечного фикса; artifact: вывод заголовков; validation: `Access-Control-Allow-Headers` содержит `last-event-id`.
3. Прогон `bun run lint` в `apps/backend` (при касании только бэка достаточно backend-линта) — reason: критерий «линтер чист»; artifact: зелёный lint; validation: `tsc --noEmit` + `biome` без ошибок.

## Open Questions
- Нет открытых вопросов, блокирующих фикс. Опционально: нужен ли e2e на preflight в будущем — вне скоупа (не делать в этой карточке).

## Next Epoch Focus
- Финализация: собрать PLAN.md (1 карточка с чек-листом, complexity/риск, done-критерии). Других эпох не нужно — глубина low достигнута.
