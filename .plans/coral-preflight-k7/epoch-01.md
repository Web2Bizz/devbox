# Epoch 1: Coarse hypothesis

## Hypothesis
- Ошибка preflight `last-event-id не разрешён согласно Access-Control-Allow-Headers` на `GET /api/v1/sessions/events?projectId=...&session=...` вызвана отсутствием `last-event-id` в `allowedHeaders` Nest CORS-конфига.
- Фикс — одна строка в `apps/backend/src/app/app.setup.ts:71-76`: добавить `last-event-id` в `allowedHeaders`.
- Фронт менять не нужно: `apps/frontend/src/api/client.ts:340` уже шлёт `Last-Event-ID`, бэк уже читает его (`?cursor=`/`Last-Event-ID` в harness). Confidence: high (90%).
- Риск точечный, остальной CORS не затронут.

## Evidence Found
- Заявление пользователя: «Да, чини CORS» + точные файл/строки и критерии (OPTIONS → `Access-Control-Allow-Headers` с `last-event-id`; GET с header проходит; остальной CORS цел; линтер чист).
- Контекст: корень `/media/codebase/@web2bizz/devbox`, ветка `feat/cli-cloud-chat` (подтверждена `git branch --show-current`).

## Decisions
- Decision: чинить только бэк-CORS, фронт не трогать.
- Alternatives considered: (a) убрать `Last-Event-ID` с фронта и оставить только `?cursor=` — rejected, ломает SSE redial-семантику и уже рабочий harness; (b) поставить `allowedHeaders: '*'` — rejected, несовместимо с `credentials: true` и расширяет поверхность.
- Rationale: минимальный diff, сохраняет credentials + allowlist origins.

## Confirmed Plan Items
1. Проверить точный список `allowedHeaders` и регистр — reason: preflight матчит case-insensitive, но нужен единый стиль; artifact: прочитанный файл; validation: цитата строк 71-76.

## Open Questions
- Точный текущий список headers и регистр?
- Есть ли тесты на CORS (e2e/spec), которые надо обновить?
- Как бэк читает `Last-Event-ID` (harness/controller) — подтвердить, что GET-сторона уже готова?

## Next Epoch Focus
- Evidence gathering: прочитать `app.setup.ts`, `client.ts:324-357`, grep `allowedHeaders|last-event-id|enableCors`, найти CORS-тесты.
