# План миграции backend на embedded `@opencode/sdk` (OpenCode V2) — только SDK, свои сессии, без HTTP

Статус: черновик v2, код не написан. Трекинг задач не используется. Работа только на стороне бэкенда; фронт/mobile вне скоупа (сломаются осознанно).

## Решение (фиксируем)
1. **Только embedded SDK.** Внешнего opencode-сервера больше нет: ни отдельного процесса на :4097, ни compose :4096, ни `OPENCODE_URL`, ни `OPENCODE_PASSWORD`/Basic. Весь раннер-взаимодействие — через `OpenCode.create()` в процессе backend. Флага `network|embedded` нет — отката на network нет.
2. **Своя система сессий в Postgres.** Источник правды по иерархии — БД, а не раннер. Цепочка: `users ↔ organizations (members) → projects (org_id) → project_sessions (project_id)`. Форки: `parent_session_id` (self-FK) + `fork_from_message_id` (указатель на сообщение, от которого пошла новая сессия). Сообщения тоже храним у себя (`session_messages`), SDK-идентификаторы — лишь маппинг.
3. **HTTP-контракт убрать.** Удаляются оба слоя: доменный `/api/sessions*` и deprecated-зеркало `/api/opencode/*` (18 роутов), вместе с DTO, контроллерами, e2e, swagger-упоминаниями и их парами в `packages/contracts` + `contracts/openapi.yaml`. Взаимодействие — прямые вызовы сервисов внутри backend.
4. **Фронт не трогаем** — он отвалится от сессий, это принято как следствие; чинить его будем отдельной задачей.

## Текущее состояние (факт на 2026-10-30)
- `src/processes/ai/opencode/`: `opencode.service.ts` (url/dialUrl/fetchWithRetry/fetchWithTimeout, `OPENCODE_URL`), `opencode-client.ts` (lazy `@opencode-ai/sdk/v2`), `opencode.controller.ts` (deprecated `/api/opencode/*`), `opencode.e2e.ts` (37 кейсов).
- `src/processes/ai/sessions/`: доменный `/api/sessions*` — `sessions.controller.ts`, `sessions.service.ts` (трансляция runner→домен, create/prompt/interrupt через `fetchWithRetry + serveBasicAuthHeader`, SSE через `sse-relay`), `sessions.dto.ts`, `sessions.e2e.ts`.
- `src/organizations/projects/sessions/`: `SessionsService` поверх `project_sessions` (`id, project_id, chat_id, status, metadata`) — привязка к проекту и чату уже есть, доступа через `assertProjectAccess`, каскадов.
- `src/common/db/schema.ts`: `projects (org_id 1:1)`, `organizations + organization_members + organization_invites`, `users`, `user_opencode_keys`, `project_chats`, `project_sessions`. Полей родителя/форка и таблицы сообщений нет.
- `src/common/sse/sse-relay.ts`, `src/common/external/*` — механика SSE и маппинг `EXTERNAL_*`.
- `src/processes/ai/opencode/modules/auth/auth.service.ts` — `serveBasicAuthHeader`; `env.ts` — `OPENCODE_*`.
- Контракты: `packages/contracts` (12 пар, включая `sessions/`, `opencode-session/`, `opencode-event/`), `contracts/openapi.yaml`, `contracts/opencode-stand-2.2.0.json` (провенанс V1).

## Факты V2 (docs opencode.ai/v2, без перепроверки в коде — подтвердить в spike)
- `OpenCode.create({plugins?})` — owned host, `await using` / `close()`, без HTTP listener.
- Алиасы `sessions` / `events`; методы create/prompt/interrupt/model/status/providers/messages.
- `events.subscribe()` — live-only, без replay и авто-реконнекта (догрузка — через messages GET, дедупликация по `id`).
- Worktree-операции требуют `projectID`.
- V2 меняет server API и plugin API; миграция с `@opencode-ai/sdk@1.18.33` не drop-in.

## Целевая архитектура
```
Backend process (NestJS)
├─ OpencodeHostService (singleton, embedded)
│    └─ OpenCode.create() — один host на процесс, close() на shutdown;
│       sessions.create/prompt/interrupt/model, events.subscribe()
├─ SessionsService (свои сессии, Postgres — источник правды)
│    ├─ project_sessions (+ parent, fork pointer, opencodeSessionId, model, title, directory)
│    └─ session_messages (история, fork pointer target, дедупликация событий)
└─ HTTP: ни /api/sessions*, ни /api/opencode/* — только внутренние вызовы сервисов
```
- Создание сессии: сначала строка в БД (project gate + jail directory из `REPOS_ROOT`), затем `sdk.sessions.create({location:{directory}})`, `opencodeSessionId` записываем обратно.
- Промпт: пишем user-сообщение в `session_messages`, вызываем `sdk.sessions.prompt`, ассистентские дельты/финал складываем в `session_messages` (идемпотентно по `opencodeMessageId`).
- Форк: `create({parentSessionId, forkFromMessageId})` — валидация «в том же проекте», контекст новой SDK-сессии собирается из истории вплоть до fork-сообщения (полный перенос истории — решение spike: копией сообщений vs ссылками).
- События: `events.subscribe()` внутри процесса; переподписка с бэкоффом; пропуски — догрузка через messages; дубликаты — по id.
- Ошибки SDK маппятся в `EXTERNAL_*` (400/422→BAD_REQUEST, 404→NOT_FOUND, сбой/таймаут→503 + Retry-After 30), логи только через `AppLogger`, без URL/секретов/стеков в normal path; e2e-скан секретов сохраняется.

## Схема БД (миграция)
- `project_sessions` добавить:
  - `parent_session_id uuid NULL → project_sessions(id) ON DELETE SET NULL` (корень — NULL; удаление родителя не валит детей);
  - `fork_from_message_id uuid NULL → session_messages(id) ON DELETE SET NULL`;
  - `opencode_session_id text NULL` (маппинг на SDK-сессию; NULL только на время создания);
  - `title text NULL`, `model jsonb NULL` (запиненный `Model.Ref`), `directory text NOT NULL` (jail-каталог проекта на момент создания);
  - `CHECK (id != parent_session_id)` против само-форка; индекс `(project_id, parent_session_id)`.
- Новая `session_messages`:
  - `id uuid PK`, `session_id uuid NOT NULL → project_sessions(id) ON DELETE CASCADE`;
  - `opencode_message_id text NULL` (идемпотентность; unique partial где NOT NULL);
  - `role text NOT NULL` (user|assistant|system|tool|shell — CHECK);
  - `payload jsonb NOT NULL` (текст/parts), `sequence bigint GENERATED ALWAYS AS IDENTITY` или `created` от SDK + индекс `(session_id, sequence)`;
  - индекс `(session_id, created_at)`.
- Backfill существующих строк: `parent_session_id=NULL, fork_from_message_id=NULL, title/metadata→сохранить в metadata, opencode_session_id=NULL` (старые SDK-сессии не мигрируем — они жили в раннере; пометить как `legacy: true` в metadata).
- `chat_id` семантику не меняем (SET NULL при удалении чата уже есть).
- Миграции: новый файл в `apps/backend/drizzle/` (+ код-first правка `src/common/db/schema.ts`); `schema-integrity.spec.ts` обновить; `drizzle-kit migrate` в проде как обычно.

## Этапы (только backend)
1. **Spike: embedded host + схема на бумаге.** Поднять `OpenCode.create()` в backend-процессе (вне DI или в тестовом модуле): create/prompt/status/interrupt на тестовой модели; проверить модели/ключи (`OPENCODE_KEYS_*` → V2), `await using` в bun/Node, лицензию/размер бандла, холодный старт; зафиксировать решение «копия истории при форке vs ссылки» и «один host на процесс vs host на проект». Подтвердить или опровергнуть факты V2 выше. Выход — `docs/opencode-embedded-spike.md`. Риск: medium.
2. **Миграция БД: родители, форки, сообщения.** `schema.ts` + SQL-миграция + `schema-integrity`; CRUD в `organizations/projects/sessions/sessions.service.ts`: `create({parentSessionId?, forkFromMessageId?})` с валидацией (родитель и сообщение — в том же проекте; сообщение принадлежит родителю либо его предку); `forkTree(sessionId)` (цепочка предков для сборки контекста); `session_messages` append/list идемпотентно. Старые `sessions.e2e`-завязки на runner не трогаем здесь. Риск: medium (data).
3. **OpencodeHostService (embedded singleton).** `OpenCode.create()` на старт приложения, `close()` на shutdown; методы create/prompt/interrupt/model/status/providers/messages/events поверх SDK; маппинг ошибок в `EXTERNAL_*` через `external-error.ts`; логи `[external]` через `ExternalClient`; удалить `OpencodeSdkClient` (V1 lazy import), `fetchWithRetry/fetchWithTimeout` к раннеру, `serveBasicAuthHeader` для раннера, `OPENCODE_URL/OPENCODE_PASSWORD` из `env.ts` (+ `.env.example` — только по явному требованию владельца правим README, `.env.example` правим сразу как код). `checkConnectivity`/`dialUrl`/probe `:4096` удалить. Риск: medium (breaking, external).
4. **Свои сессии поверх SDK.** `SessionsService` переписать: БД — источник правды, SDK — исполнитель. Создание (БД→SDK→обратная запись `opencodeSessionId`); промпт (запись user → SDK → запись assistant); interrupt/model/status через маппинг; события — подписка + догрузка + дедупликация в `session_messages`; форк — сбор контекста до `forkFromMessageId`. `project_sessions.status` вести у себя (open/closed/busy/idle — по подписке, а не по runner `active`). Риск: medium (breaking, data).
5. **Ошибки, таймауты, логи, секреты.** Маппинг 400/422/404/503 как раньше, но источник — исключения SDK, не HTTP статусы раннера; таймауты через AbortSignal в request options SDK; e2e-скан секретов (эталон `processes/ai/opencode/keys.e2e.ts`) — без ключей/Bearer/URL; `warn/error` без `\n`. Риск: medium (security).
6. **Удаление HTTP-контракта.** Удалить: `src/processes/ai/sessions/*` (контроллер/DTO/e2e), `src/processes/ai/opencode/opencode.controller.ts` + `opencode.e2e.ts`, упоминания в `app.module.ts`, swagger (`app.setup.ts`), `versioning.e2e.ts` ожидания, пары `sessions/`, `opencode-session/`, `opencode-event/` в `packages/contracts` + `contracts/openapi.yaml` + `contracts.ts` реэкспорты, `contracts/opencode-stand-2.2.0.json` (архивировать, не молча удалять — решение spike п.5 прошлого плана). Фронт/mobile осознанно ломаются; в план не входят. Риск: high (breaking — намеренный).
7. **Чистка стенда и зависимости.** Удалить `@opencode-ai/sdk@1.18.33` из `package.json` + lock; добавить `@opencode/sdk` (V2, версия из spike); `apps/opencode-server` — удалить compose-стек или зафиксировать удаление отдельной задачей; `bun run lint` + `bun run build` зелёные; стенд поднимается без опенкод-процесса. Риск: medium (external: Dokploy/стенд).

## Зависимости
- 2 ← 1 (схема зависит от решений spike: копия-vs-ссылки, host-scope).
- 3 ← 1. 4 ← 2, 3. 5 ← 4. 6 ← 4, 5. 7 ← 6.
- Параллелить нельзя: 4 пишет в схему из 2 через хост из 3; 6 удаляет то, что 4 переписывает.

## Критерии готовности
- Внешнего opencode-процесса нет: ни env (`OPENCODE_URL/PASSWORD`), ни dial/probe, ни `:4096/:4097` в коде backend.
- `project_sessions` с родителями/форками + `session_messages` работают: создание, форк от сообщения, дерево предков, каскады (удаление проекта валит сессии и сообщения; удаление родителя обнуляет `parent_session_id`, сообщения детей живы).
- Промпт/интеррапт/модель идут только через SDK; истории в БД и SDK консистентны (идемпотентность по `opencode_message_id`).
- HTTP `/api/sessions*` и `/api/opencode/*` отсутствуют в коде, swagger и контрактах.
- `bun run lint` + `bun run build` зелёные; e2e-скан секретов чистый; V1-зависимость отсутствует в `package.json`/lock.
- Фронт/mobile — вне готовности (сломаны осознанно).

## Откат
Отката на внешний раннер нет (решение п.1). Откат внутри этапов — только вперёд: `revert` миграции БД новой миграцией, удаление — восстановлением из git. До этапа 6 старый HTTP ещё жив и служит страховочной сеткой для ручной проверки.

## Оценка
Сложность high, риск high (breaking намеренный + data + security + external). Этап 1 — medium spike; этапы 2–7 — `build-smart`, по одному за раз, строго последовательно.

## Следующий шаг
Начать этап 1 (spike). Перед кодом закрыть два вопроса: копия истории при форке или ссылки; один host на процесс или host на проект/сессию.
