# AGENTS.md — Rush Code (monorepo)

Монорепо: `apps/backend` (NestJS API), `apps/frontend` (Next.js 16.3
Turbopack + `@web2bizz/ui` 0.26.0), `apps/mobile` (Expo 57 / RN 0.86 +
`@web2bizz/ui-native`), `contracts/openapi.yaml`, `apps/opencode-server`
(образ opencode, отдельный compose-стек под Dokploy — Dockerfile без
package.json, не Nx-проект, вне bun workspaces).

`apps/mobile` — самостоятельный npm-проект (свой `package-lock.json`,
`--legacy-peer-deps`), намеренно **вне bun workspaces**: ставится и запускается
из своей директории, без `bun --filter`.

## Имя проекта и локальный стенд

- Проект называется **Rush Code** (`rush-code`): корневой `package.json` `name: rush-code`, docker-registry `web2bizz/rush-code/<service>`, README `# Rush Code — monorepo`. Remote-репозиторий/GitHub и каталог на диске остаются `devbox` (переименование remote/path — отдельная задача, не делается молча).
- Локальный стенд — строго по корневому `README.md` → `# Запуск → ## Локальный запуск` (и `## Production запуск`). Команды/порты/env-имена берутся оттуда, ничего не выдумывать; раздела/подраздела нет (или заголовки не совпали дословно) — fail-closed, работы прекращаются. README раздел `Запуск` правится только по явному требованию пользователя.
- Имена pm2-процессов стенда: `rush-backend` (3100), `rush-frontend` (3001), `rush-opencode` (4097, изолированный `OPENCODE_CONFIG_DIR`, запускается с `--cwd "$REPOS_ROOT"` — дефолтная локация раннера = каталог проектов, не корень репо), `contracts-watch`. `pm2 restart` — мутация, её делает человек; `bun run dev:backend`/`dev:frontend` идут через nx (`scripts/dev/with-env.ts` подхватывает `.env`).
- pm2-ловушка окружения: `with-env.ts` отдаёт приоритет `process.env` над `.env`; стартуй pm2 с `env -u DATABASE_URL -u POSTGRES_* …` (как в README), иначе backend поднимется на чужой БД. `JWT_ACCESS_SECRET` опционален (без него эфемерный dev-секрет, сессии сбрасываются при рестарте); `JWT_REFRESH_SECRET` тоже эфемерный → refresh-токены инвалидируются при рестарте.
- `REPOS_ROOT` — единственный источник storage; без него storage-чтения → 503 `EXTERNAL_UNAVAILABLE`, создание проектов → 500, boot продолжается с ERROR-логом. Никогда не читать/создавать `<cwd>/repos`.

## Общий пакет контрактов

- `@rush-code/contracts` (`packages/contracts`, 0.1.0) — единый wire-контракт бэкенд↔фронт. 12 пар `entity.ts` + `entity.schema.ts` (health, session, repo-entry, api-error, auth, project, organization, opencode-key, opencode, opencode-session, opencode-event, sessions): типы + zod v4 boundary-схемы (Standard Schema, backend-verbatim ограничения), без рантайм-логики. `opencode-session`/`opencode-event` — зеркальные wire-формы (карточка 3), `sessions` — доменный контракт `/api/sessions*` (`SessionInfo`, `SessionMessage`, `SessionStreamFrame`, `SessionRunnerProvider`, `SessionInterruptResult`, `SessionModel`) и его boundary-схемы.
- `contracts/openapi.yaml` — источник правды wire-контракта: пакет зеркалит `components/schemas` поле-в-поле (Health.status enum `[ok]`, Project.scope optional и т.д.). Расхождение YAML ↔ пакет — баг пакета, не фича.
- backend/frontend — bun workspaces (`workspace:*`, уже в `workspaces` корня + `tsconfig.base.json` paths). mobile — standalone npm: `file:../../packages/contracts` + `npm install --legacy-peer-deps` (см. `apps/mobile/AGENTS.md`) + резолв `metro.config.js` watchFolders/extraNodeModules + `tsconfig.json` paths.
- `apps/backend/src/contracts.ts` и `apps/frontend/src/api/types.ts` — deprecated-реэкспорты (Forward-Only, на один релиз, новых экспортов не добавлять). `apps/frontend/src/lib/auth-schemas.ts` — такой же алиас; `apps/mobile/src/shared/api/backend-contracts.ts` — тонкий шим + `parseBackend*` fail-fast хелперы.
- Имя: `contracts` основное (контракт + валидация границы), `entities` — содержимое пар. `packages/shared` отклонён — слишком общее (сваливает контракты, утилиты и сторы в одну кучу).

## Frontend — дизайн-система

- Общие правила для всех UI-приложений — реферат
  [`DESIGN.md`](DESIGN.md) (корень). При расхождении с прикладным
  `DESIGN.md` побеждает **прикладной**: `apps/frontend/DESIGN.md` (веб-шелл)
  и `apps/mobile/DESIGN.md` (mobile) ближе к коду и кит-версии.
- Договорённости по layout/токенам/радиусам/бренду:
  [`apps/frontend/DESIGN.md`](apps/frontend/DESIGN.md) — читать перед
  правками шелла (`dashboard-shell`, `layout/Sidebar`, `layout/Content`,
  `app/globals.css`).
- Mobile: [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md) — структура и
  гейты mobile-приложения.
- Порядок стилей: `@web2bizz/ui/styles.css` → `globals.css`
  (source order, не менять). Hex — только `:root` / `.dark`.
- Проверки после правок фронта: `bun run lint` (`nx run-many -t lint`:
  `tsc --noEmit` + `biome lint` per project) + `bun run build`
  (`nx run-many -t build`, фронт → `next build --turbopack`). Точечно —
  `bun run lint:affected` / `bun run build:affected` (`nx affected -t …`),
  граф — `bun run graph`. Низкоуровнево — `bun --filter <app> <script>`
  напрямую; dev-чейны (`dev`, `dev:backend`, `dev:frontend`) идут через nx
  (`run-many -t dev` / `run <project>:dev`, contracts build — `dependsOn:
  ^build`, `.env` — `scripts/dev/with-env.ts`).
  После правок mobile — гейты из `apps/mobile/AGENTS.md` (npm, не bun).

## Frontend — слои (apps/frontend)

- Слои живут здесь (в прикладном `apps/frontend/AGENTS.md` — только Next.js-блок и уточнения границы, правила слоёв не дублировать).
- Источники: `apps/frontend/tsconfig.json` (`@/*` → `./src/*`, `./app/*`;
  на 2026-10-20 `@/` использует только `app/(dashboard)/profile/page.tsx`
  (4 импорта), остальной код — на относительных),
  `apps/frontend/next.config.mjs` (слоёв не задаёт), фактическая структура
  `app/` + `src/{api,components,features,hooks,i18n,lib}`. Каталогов
  `entities/` и `shared/` нет — не выдумывать. `src/providers.tsx` — файл
  в корне `src/` (DESIGN §3.4 пишет `src/providers` исторически).
- Правило: `app/` — только тонкая композиция (страница владеет
  `<ФичаСекция />`, бизнес-логика — в `features/` + `hooks/`).

| Слой | Путь | Что класть | Алиас (`@/*`) | Пример импорта |
| ---- | ---- | ---------- | ------------- | -------------- |
| Маршруты | `app/` | `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`; `globals.css` | `@/*` → `./app/*` | маршруты резолвит роутер, не импорты |
| Фичи | `src/features/<имя>/` | фича-модуль целиком: UI-секция + диалоги + локальный статус (`usage/`: `usage-section.tsx`, `api-key-dialog.tsx`, `usage-status.ts`, `__tests__/`) | `@/features/*` | `@/features/usage/usage-section` (из `app/(dashboard)/profile/page.tsx`) |
| Компоненты | `src/components/` | общие презентационные компоненты (`states`, `layout/`, `profile/`, `projects/`, …) | `@/components/*` | `../../components/states` (из `src/features/usage/`) |
| Хуки | `src/hooks/` | data-хуки (`useUsage`, `useProfile`, …) + `query-keys.ts` | `@/hooks/*` | `../../hooks/useUsage` (из `src/features/usage/`) |
| API | `src/api/` | HTTP-клиент (`client.ts`, единственный fetch-слой) + доменный фасад `sessions-client.ts` (над `client.ts`); реэкспорт контрактов (`types.ts` — deprecated-реэкспорт `@rush-code/contracts`, своих типов не заводить). `opencode-client.ts` (SDK-клиент) **удалён** — фронт не знает об opencode. | `@/api/*` | `../../api/types` (из `src/features/usage/`) |
| Lib | `src/lib/` | утилиты, сторы (`auth-store`, `format-error`) + алиасы схем (`auth-schemas` — реэкспорт пакета); `project/org-schemas` локально строже wire (UX trim/min/max/charset/i18n-коды, subset wire) с комментом-обоснованием | `@/lib/*` | `../../lib/auth-store` (из `src/features/usage/`) |
| i18n | `src/i18n/` | словарь en/ru, провайдер | `@/i18n/*` | `../../i18n` (из `src/features/usage/`) |

### Data-хуки — только React Query

- Все data-хуки `src/hooks/*` — на `useQuery`/`useMutation`/`useQueryClient`
  через `src/providers.tsx:createQueryClient` (staleTime 30s, gcTime 5m,
  retry 1, `refetchOnWindowFocus: false`).
- `queryFn` бросает raw `ApiClientError` (без форматирования); формат —
  в `useMemo` через `format-error` + `t` (см. `useProjects`, `useAiProviders`, `useUsage`).
- `reload` = `invalidateQueries({ queryKey })`; оптимистичные правки —
  через `setQueryData` + `invalidate`.
- Ключи — только из `src/hooks/query-keys.ts` (single source; пример:
  `sessionsQueryKey(projectId)` → `['sessions', projectId ?? 'none']`).
- Исключение — streaming/SSE (`useChat`): остаётся на `useEffect`
  (живые дельты доменного SSE `GET /api/sessions/events` + очередь prompt
  с `AbortController`, бэкофф 1s→15s) с комментом-обоснованием; на React
  Query не переносится (wontfix — см. аудит Card3). Кадры стрима:
  `session.text.delta`/`session.text.ended` (текст), финал хода —
  `session.step.ended`/`session.execution.succeeded`; имена
  `message.part.*`/`session.idle` — V1-наследие, в `frameText` оставлены
  только как compat.

## Фолбэки запрещены по умолчанию

- Никаких тихих фолбэков (дефолтные пути вроде `<cwd>/...`, захардкоженные хосты/порты, подмена отсутствующего значения «удобным») без явного указания пользователя. Не задано → ошибка, а не додумывание.
- Особенно строго: валидация конфигов и env-переменных (`env.ts`, `.env.example`, `resolveRoot`-подобные резолверы). Отсутствующая обязательная переменная для записи/мутации → fail-fast с понятной ошибкой (что задать, где), а не fallback-путь и не WARN-тихоня. Фолбэк для чтения/readonly допустим лишь как исключение для тюнинга (таймауты/ретраи/хосты dev-dial) и фиксируется комментарием — но НЕ для путей хранения.
- Единый каталог: `REPOS_ROOT` — единственный источник чтения И записи всего storage (repos list, workspaces tree/submodules, project-files tree, clone dest, projects create/remove). Без конфига — отказ: storage-чтения отвечают 503 `EXTERNAL_UNAVAILABLE` (Retry-After 30, с correlationId), создание проектов — 500 до INSERT; boot без корня продолжается, но лог на уровне ERROR честно сообщает о недоступности (health без изменений). Исключения: `GET /projects` и `GET /projects/:id` без корня — как сейчас (`corrupted` + `storage-unconfigured`). Никогда не читать/создавать `<cwd>/repos`, не отдавать молча `[]`/404 по нему.
- Прецедент: тихий fallback `REPOS_ROOT` → `<PROJECTS_ROOT>/repos` → `<cwd>/repos` молча создавал проекты не там (см. strict-резолвер projects) — так больше не делать; цепочка удалена полностью, включая READ-пути.

## OpenCode — граница backend/frontend (жёстко)

- Фронтенд **ничего не должен знать об opencode**: никаких импортов `@opencode-ai/sdk` в `apps/frontend` (guard-тест `apps/frontend/src/__tests__/no-opencode-transport.test.ts` ловит регрессию в коде и комментариях), никаких путей `/api/opencode/*` в UI. Публичный доменный контракт — `/api/sessions*` (`GET/POST /api/sessions`, `status`, `models`, `messages`, `interrupt`, `providers`, `events` SSE) в `@rush-code/contracts` (`packages/contracts/src/sessions/`).
- Бэкенд — единственный владелец opencode-транспорта. `/api/opencode/*` остаётся deprecated-алиасом на один релиз (Forward-Only); удаление — отдельная задача после релиза.
- Liveness бэкенда — `GET /api/info` (2.x не имеет `/api/health`, `/health`/`/global/health` отдают SPA). `OpencodeService.checkConnectivity()` трактует `401+JSON` как `up` (liveness ≠ auth).
- Upstream-вызовы бэкенда должны spread'ить `serveBasicAuthHeader()` (генератор единый, `opencode-auth.service.ts`); `fetchWithRetry`/`fetchWithTimeout` сами авторизацию не добавляют. `global/health` — исключение из правила «анонимен»: браузерный вход анонимен, upstream-проб идёт с серверным Basic.
- `@opencode-ai/sdk@1.18.33` — V1-поколение: молча режет неизвестные ключи тела (`title`/`parentID` в `session.create`), `stripEmptySlots` убирает пустой `body`. Доменные маршруты обходят генератор через `fetchWithRetry` + `serveBasicAuthHeader` с **непустым** телом.
- Модель пинится **созданием сессии**: `POST /api/session` принимает `model` (`Model.Ref`), prompt-body — **нет** (`additionalProperties:false`, live-подтверждено на 2.2.3: model в prompt → 400 или игнор). Раннер хранит модель на сессии (`Session.Info.model`); переключение живой сессии — upstream `POST /api/session/{id}/model` (доменного маршрута ещё нет). Провенанс всех спорных форм — `contracts/opencode-stand-2.2.0.json` (снапшот живой спеки; артефакт важнее протухших типов sdk).
- Ошибки upstream не маскируются: `400/422` → `EXTERNAL_BAD_REQUEST`, `404` → `EXTERNAL_NOT_FOUND` (оба без `Retry-After`, `isRetryable:false`); реальный сбой/таймаут → `EXTERNAL_UNAVAILABLE`/503 + `Retry-After: 30`. `cause` сериализуется `serializeCause` (из `app-logger.service.ts`) — никогда `[object Object]`, только в `debug`, ≤2000.
- `OpencodeService.fetchWithRetry` к upstream-`/api/info` для liveness идёт без Basic — это намеренно (401+JSON = up), не «копипаста-баг».

## Логирование — без стеков и секретов в normal path

- Единственный путь логов бэкенда — `AppLogger` (`apps/backend/src/common/app-logger.service.ts`). Никогда `console.*` в runtime-коде. Уровни: `debug` → `info` (`log`-алиас) → `warn` (деградация, отвечаем) → `error` (операция провалена) → `fatal` (процесс не продолжается). Уважает `LOG_LEVEL`, fail-open в `info`.
- Normal path — однострочники без стека: `warn`/`error` никогда не содержат `\n at `, стек туда не передаётся. `AppLogger.error(message, stack?, correlationId?)` стек (второй/третий аргумент с `\n`) санитизирует (маска URL-кредов, scrub live-секретов, срез 2000) и отдаёт только в `debug` (`stack=…`); сам `error` — одна строка. `Error` в сообщении → только `message`. Диагностика не должна ломать error-строку.
- Секреты не логируются никогда: известные secret-ключи → `[redacted]`, `scheme://user:pass@host` → `://***:***@`, значения `DATABASE_URL`/`POSTGRES_PASSWORD`/`DOCKER_*`/`NPM_*`/`JWT_*`/`OPENCODE_KEYS_*` scrub → `[redacted]`. Запрещены URL/query/headers/body/`Bearer`/токены/пароли/connection strings/PII (напр. email) — только фиксированные имена событий `[domain] op key=value` + `correlationId` (`[cid]` префикс).
- `ExternalClient` (`apps/backend/src/common/external/external-client.ts`, `service`/`operation` + `correlationId`): только поля `service/operation/attempt/latencyMs/status/code`, без URL/body. Формат:
  - `debug`: `[external] start service=<s> operation=<op> method=<m>` / `[external] success service=<s> operation=<op> attempt=<n> status=<http> latencyMs=<ms>`;
  - `warn`: `[external] retry service=<s> operation=<op> attempt=<n> status=<http> code=<CODE> latencyMs=<ms>`;
  - `error`: `[external] failure service=<s> operation=<op> status=<http|-> code=<CODE> attempt=<n> latencyMs=<ms>`;
  - `debug`: `[external] cause service=<s> operation=<op> code=<CODE> detail=<sanitized, ≤2000>`.
- Billing (`OpencodeBillingService.getUsage`, `service='opencode-billing'`): `warn`-однострочники `[opencode-billing] getUsage … status=<http> code=<CODE>` (`rejected/upstream/shape mismatch/bad json`), без стека и без URL/body/`Bearer`; ключ живёт только в памяти запроса (Bearer upstream), `stack`/`cause` — только в `debug`. Примеры см. в JSDoc сервиса.
- Фильтр (`ApiErrorFilter`): normal path — `[http] handled … status=<http> code=<CODE>` (`service/operation/status/code` для `ExternalServiceError`), `error` только для `429/5xx` (c `Retry-After: 30`), иначе `warn`; неизвестные — `[http] unhandled status=500 code=internal_error` в `error`. `cause`/`stack` (≤2000, санитизирован) — только в `debug`: `[http] cause … detail=…`. Без body/headers. SSE-обрыв закрытого downstream (`req.destroyed/headersSent`) — штатно, тихо в `debug`, без ответа.
- e2e-скан секретов и формы обязателен (эталон — `apps/backend/src/opencode-keys/opencode-keys.e2e.ts`): перехватить все методы `AppLogger` (`debug/info/warn/error`) на весь сьют, в конце assert: дамп не содержит ключ/секрет/`"Bearer "`/upstream-URL; все `warn`/`error` без `\\n` (стек только в `debug`); текст содержит `getUsage` + `status=` + `code=` + `[http] handled` + `[external]`.
