# PLAN.md — Фикс CORS preflight `last-event-id` (coral-preflight-k7)

> Синтез epoch-01 → epoch-02. Только план, без кода. Ветка: `feat/cli-cloud-chat`. Корень: `/media/codebase/@web2bizz/devbox`.

## Цель
OPTIONS preflight на `GET /api/v1/sessions/events?projectId=...&session=...` отвечает с `Access-Control-Allow-Headers`, включающим `last-event-id`; GET events с header `Last-Event-ID` проходит; остальной CORS не сломан; линтер чист.

## Карточка 1 (единственная): `fix(cors): allow last-event-id in preflight`
- Тип: `update` (точечный фикс, 1 файл, 1 строка).
- Файлы:
  - править: `apps/backend/src/app/app.setup.ts:71-76` (массив `allowedHeaders`).
  - читать/не менять: `apps/frontend/src/api/client.ts:324-357` (строка 340 — источник header), `apps/backend/src/processes/modules/ai/modules/sessions/sessions.controller.ts:311`, `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts:1022-1025` (подтверждение, что GET-сторона готова).
- Чек-лист:
  1. [ ] В `allowedHeaders` добавлен `'last-event-id'` (lowercase, остальные 4 записи без изменений: `content-type`, `x-correlation-id`, `x-user-id`, `authorization`).
  2. [ ] `origin`/`methods`/`exposedHeaders`/`credentials` не менялись (diff — только одна строка массива).
  3. [ ] Проверка preflight: `curl -i -X OPTIONS <backend>/api/v1/sessions/events -H 'Origin: <frontend>' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: last-event-id,authorization,content-type'` → ответ 2xx + `Access-Control-Allow-Headers` содержит `last-event-id`.
  4. [ ] Проверка GET: запрос events с `Last-Event-ID` + `Authorization` от разрешённого origin проходит без CORS-блокировки (harness уже понимает header/`?cursor=`).
  5. [ ] `rg -n "allowedHeaders" apps/backend/src` показывает 5 entries; `git diff --stat` — только `app.setup.ts`.
  6. [ ] `bun run lint` в `apps/backend` зелёный (`tsc --noEmit` + `biome`); при желании `bun run build` в `apps/backend`.
- Complexity: **low** (score ~2/20: 1 файл, 0 новых зависимостей, 0 неизвестных — все стороны подтверждены чтением кода).
- Риск: **low** (score ~1/8: изменение аддитивное, allowlist; факторы: нет breaking/data/security/external; `credentials:true` не трогаем, wildcard не вводим).
- Done-критерии:
  - OPTIONS preflight включает `last-event-id` в `Access-Control-Allow-Headers`.
  - GET `/api/v1/sessions/events` с `Last-Event-ID` не блокируется браузером.
  - Остальной CORS (origins, credentials, другие headers) работает как раньше.
  - Линтер чист.
- Stop-условие: если preflight всё ещё без `last-event-id` после правки — стоп, проверить кэш сборки/прокси, не расширять скоуп.
- Вне скоупа (не делать): новый e2e на CORS, правки фронта, `allowedHeaders: '*'`, смена origins/credentials.

## Почему вторая карточка не нужна
Верификация (curl + lint) входит в чек-лист карточки 1 — выделять отдельную карточку на проверку нецелесообразно для однострочного фикса без CORS-тестов в репо.

## Conflict check
- Конфликтов нет: фронт уже шлёт header, бэк уже читает, CORS-тестов нет (нечего обновлять), `main.ts:78 cors:false` относится к другому адаптеру и не конфликтует с `configureApp`.
