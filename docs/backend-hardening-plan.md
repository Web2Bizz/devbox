# План: закрыть бэкенд после C1–C7

Вводные: e2e с живой БД идут через testcontainers (внедрено, см. ниже).

## Сделать человеку

1. Заполнить `.env` по `.env.example`: `DATABASE_URL`, `REPOS_ROOT`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OPENCODE_KEYS_ENCRYPTION_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`.
2. Сделать backup перед миграцией: `pg_dump "$DATABASE_URL" > backup_$(date +%F-%H%M).sql`.
3. Выполнить миграции по порядку: `apps/backend/drizzle/0002_soft_delete.sql`, затем `apps/backend/drizzle/0003_refresh_tokens.sql` — `cd apps/backend && bunx drizzle-kit migrate` либо вручную через psql.
4. Проверить схему: `cd apps/backend && bun run db:check-integrity`.
5. Проверить сборку: `cd apps/backend && bun run build`.
6. Прогнать unit: `cd apps/backend && bun run test`.
7. Прогнать e2e: `cd apps/backend && bun run test:e2e` — нужен запущенный Docker (Postgres поднимается в testcontainers). Сьюты идут через `scripts/e2e.ts` с таймаутом на сьют (`E2E_SUITE_TIMEOUT_MS`, по умолчанию 300000).
8. Проверить мобильный клиент: он парсит `opencodeUsageSchema` (в `apps/mobile`), а `*At` теперь строго `z.iso.datetime()` — убедиться, что бэкенд отдаёт ISO везде.
9. Убедиться, что клиенты не используют удалённые маршруты: `GET /api/v1/projects` (теперь 404) и 410-заглушки `POST/DELETE /organizations/{id}/projects/{projectId}`.
10. Закоммитить фикс парсера `Blocked by:` в отдельном репозитории `.opencode` (три файла: `scripts/task-manager/audit.sh`, `scripts/task-manager/dump.sh`, `scripts/planner/run.sh`).

## Testcontainers (сделано)

1. devDeps `testcontainers` + `@testcontainers/postgresql`, образ `postgres:16-alpine`.
2. `apps/backend/src/common/db/e2e-db.container.ts`: `startTestDb()` поднимает контейнер, применяет миграции один раз, возвращает `{ mode, url, stop }`; без Docker — явная ошибка.
3. `TEST_DATABASE_URL` — переиспользование внешнего Postgres (недоступный override → ошибка, не тихий 503); `E2E_DB_MODE=unreachable` — только явная проверка outage-поверхности.
4. 5 строгих сьютов (`auth`, `organizations`, `projects`, `github`, `keys`) переключены на `startTestDb()`; контейнер гасится в `finally`, Ryuk добирает при аварии.
5. Прогон: live-режим зелёный — auth 18/18, organizations 15/15, projects 20/20, github 24/24, keys 27/27.
6. `scripts/e2e.ts` — запуск по одному сьюта с таймаутом (`E2E_SUITE_TIMEOUT_MS`); `bun run test:e2e` зелёный — 39/39 сьютов.
7. Документация: `apps/backend/AGENTS.md` (таблица скриптов + разделы «e2e и Postgres», «Запуск e2e»).

Осталось: CI-джоб с доступом к Docker и кэшем образа; прогон параллельно (сейчас — контейнер на процесс).

## Осталось в коде

1. Закрыть окно first-claim GitHub: подписанный state не привязан к installation — нужен nonce/pending-claim по webhook `installation.created`.
2. Запланировать `TokenService.pruneExpired()` (cron или boot-задача) — сейчас вызывается только вручную.
3. Починить `apps/backend/drizzle.config.ts` (указывает на несуществующий `src/db/schema.ts`), затем сгенерировать миграции штатно и сверить с ручными `0002`/`0003`.
4. Добавить e2e на канонические маршруты регистри (`/registry/docker`, `/registry/npm`) — сейчас покрыты только deprecated-дубли.
5. Убрать мёртвый `listProjects` во фронтовом клиенте (`apps/frontend/src/api/client.ts`), он зовёт удалённый `GET /projects`.
6. CoC §2: перестать экспортировать вложенные модули наружу (`projects`, `opencode`, `registries`, `organizations`).
7. CoC §3: убрать `@Global()` с доменных модулей — оставить один `common.module.ts`.
8. Привести `workspaces.dto.ts` и оставшиеся DTO к единому allow-list-сообщению (сейчас совпадает, но описание дублируется).

После каждого пункта: `bash .opencode/scripts/check/run.sh --json` и `bun run test`, один коммит на изменение.

## Порядок

1. «Сделать человеку» 1–7: `.env`, backup, миграции `0002`/`0003`, integrity, build, unit, e2e (Docker).
2. «Осталось в коде» 1–8: задачи без живой БД.
3. «Testcontainers»: CI-джоб с Docker и кэшем образа.
4. «Сделать человеку» 8–10: мобильный парсер, удалённые маршруты, `.opencode`.
