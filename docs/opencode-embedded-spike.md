# Embedded OpenCode SDK — spike (этап 1 миграции)

## Цель

Поднять `@opencode/sdk@2.2.5` (OpenCode V2) **внутри процесса backend** и
проверить, что он может заменить внешний opencode-раннер: создать host,
создать/прочитать/закрыть сессию, не открывая HTTP-листенер и не используя
`OPENCODE_URL` / `OPENCODE_PASSWORD` / Basic-авторизацию.

Это первый безопасный этап: consumers (sessions/controller/health-probe) пока
**не переключены** и продолжают работать через старый `OPENCODE_URL`.
Новый host доступен в DI как `OpencodeHostService`, но никем не используется.

## Что проверено

- **In-process, без листенера.** `OpenCode.create()` собирает HTTP-роутер
  OpenCode в памяти и отдаёт handle; отдельный процесс/порт не поднимается.
- **Холодный старт.** `host.create` ≈ **150 ms** (замер `startupMs` в
  `[opencode-host] ready`), БД — локальный файл в `tmpdir()`.
- **Сессии.** `sessions.create({ location: { directory } })` →
  `sessions.get(...)` → `sessions.close(...)` работают; `id` сессии
  возвращается и пригоден для маппинга в Postgres (`project_sessions`).
- **Поверхности SDK.** Доступны `sessions`, `events`, `providers`, `models`
  (create/prompt/interrupt/model/status/providers/messages, live-подписка
  `events.subscribe()`); вложенные worktree-операции требуют `projectID`.
- **Жизненный цикл.** `host.close()` освобождает ресурсы; `onModuleDestroy`
  закрывает host, повторный `getHost()` после close создаёт новый.

Smoke-проверка живёт в
`apps/backend/src/processes/modules/ai/modules/opencode/__tests__/opencode-host.spec.ts`
(запускается из `dist` через `bun run test`).

## Реализация

`OpencodeHostService` (`apps/backend/src/processes/modules/ai/modules/opencode/opencode-host.service.ts`):

- singleton на процесс, ленивый `onModuleInit` (сбой старта логируется, но не
  валит Nest boot — consumers получают типизированный 503);
- `getHost()` — single-flight; ошибка старта → `ExternalServiceError`
  `EXTERNAL_UNAVAILABLE` (`operation=host.start`, retryable);
- `isUp()` — дешёвый health-флаг; `onModuleDestroy` → `host.close()`;
- в модуле зарегистрирован в `providers`/`exports`, health-probe и старые
  провайдеры (`OpencodeService`, `OpencodeSdkClient`) не тронуты.

## Ограничения

- **ESM-only.** `@opencode/sdk` не имеет `require`-условия в exports map, а
  backend собирается в CJS. Поэтому в сервисе только `type import` +
  динамический `import('@opencode/sdk')`; `.swcrc` держит
  `module.ignoreDynamic: true`, чтобы SWC не превратил `import()` в
  `require()`. Значение SDK статически импортировать нельзя — dist упадёт
  на boot.
- **SDK DB — кэш, не источник правды.** Сейчас файл БД лежит в
  `tmpdir()/rush-code-opencode/sessions.db` (прототип: переживает рестарт
  процесса, но не является durable-хранилищем). Источник правды по сессиям,
  форкам и сообщениям — **Postgres**; SDK-идентификаторы — маппинг.
- **Consumers пока на старом пути.** `SessionsService`, `OpencodeController`,
  `/api/opencode/*`, health-probe и `OPENCODE_URL`/`OPENCODE_PASSWORD`
  остаются как есть до следующих этапов; `OpencodeHostService` ещё никем не
  вызывается.
- **События.** `events.subscribe()` — live-only, без replay и
  авто-реконнекта: догрузка через messages, дедупликация по `id` — задача
  этапа «свои сессии поверх SDK».

## Дальнейшие этапы

Полный план и порядок зависимостей:
[`.plans/opencode-sdk-migration/PLAN.md`](../.plans/opencode-sdk-migration/PLAN.md).

1. ✅ Spike embedded host (этот документ) + сервис в DI без переключения
   consumers.
2. Миграция БД: `parent_session_id`, `fork_from_message_id`,
   `opencode_session_id`, `session_messages`.
3. Развитие `OpencodeHostService`: prompt/interrupt/model/status/providers/
   messages/events, маппинг ошибок SDK в `EXTERNAL_*`.
4. `SessionsService` поверх SDK: Postgres — источник правды, SDK — исполнитель.
5. Ошибки/таймауты/логи/секреты.
6. Удаление HTTP-контракта (`/api/sessions*`, `/api/opencode/*`).
7. Чистка `@opencode-ai/sdk`, `apps/opencode-server`, env `OPENCODE_URL`/
   `OPENCODE_PASSWORD`.
