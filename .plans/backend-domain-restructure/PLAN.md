# План реструктуризации backend по scope: Common / Organization (⊃ Project) / Processes

Статус: черновик v2 (правки: platform→common, crypto/keys→common, projects внутри organizations, ai+workers→processes), код не написан. Трекинг задач не используется.
Принцип: только перемещение и выделение границ, без изменения поведения.
Каждый этап — зелёные `bun run lint` + `bun run build`, e2e не краснеют.

## 0. Зачем и что чиним (факт на 2026-11-01)

Текущее дерево `apps/backend/src/` — историческое, не scope-ориентированное:

```
src/
├─ main.ts, contracts.ts (deprecated-реэкспорт @rush-code/contracts)
├─ app/ — AppModule (DI-граф), app.setup.ts
├─ common/ — logger, env, validation, external, api-error, interceptors, sse-relay + common.module + db/ (schema.ts, db.module/service)
├─ health/ — GET /health
├─ users/ — users.module/service + auth/ (auth.module, jwt-auth.guard, token/password services, dto)
├─ organizations/ — organizations.module/service/controller + org-projects.controller
│   └─ modules/ — crypto/, keys/, projects/ (projects.module + modules/files,github,sessions,chats), registries/ (modules/docker,npm)
├─ repos/ — REPOS_ROOT реестр, jail (repos-git.util, assertInsideJail)
├─ workspaces/ — per-user surface (workspace-path/clone/submodules, clone-jobs.repository)
│   └─ modules/ — clone/, path/ (WorkspacePathService)
├─ storage/ — storage-unavailable.ts (единый 503-гейт без корня)
├─ ai/ — AiModule (агрегатор)
│   └─ modules/ — agents/, workers/, opencode/ (transport + mirror 18 роутов + modules/crypto,keys,billing,auth,client), sessions/ (доменные /api/sessions* 9 роутов)
└─ (legacy по ARCHITECTURE.md: api/, docker-registry/, npm-registry/ — сверять с фактом, часть уже переехала в organizations/modules/registries)
```

Проблемы:

1. **Два места для одного scope.** Проекты живут в `organizations/modules/projects/`, а сессии/опенкод — в `ai/modules/`. Зависимость `organizations → ai` и `ai → organizations` неявная, риск цикла.
2. **`common/db` внутри `common/`.** БД — платформенная зависимость, её импортируют все. Лежит рядом с логгером и SSE — легко зацепить лишнее одним импортом `CommonModule`.
3. **Три jail-источника.** `repos/` (git-дерево), `workspaces/modules/path` (`WorkspacePathService`), `storage/` (503-гейт), плюс `PROJECTS_ROOT`/`REPOS_ROOT` в `env.ts`. Правило «REPOS_ROOT — единственный источник» (AGENTS.md) размазано по трём модулям.
4. **Секреты размазаны.** `OPENCODE_KEYS_*` (KEK active/previous + keyId), `JWT_*`, `GITHUB_*`, `DOCKER_*`, `NPM_*`, `OPENCODE_PASSWORD` — все в одном `common/env/env.ts` (~1200 строк). Нет деления «платформа / орг-уровень / проект-уровень».
5. **`users/auth` внутри `users/`.** Auth — платформенный механизм (JWT guard, C4-гейт `assertProjectAccessById`), а не часть user-профиля. Сейчас `AuthModule` вложен, `UsersModule` — global без импорта.

Цель — три уровня scope с однонаправленными зависимостями.

## 1. Три уровня scope

| Scope | Что это | Что владеет | От кого зависит |
|---|---|---|---|
| **Common** | Кросс-каттинг, нет бизнес-смысла. Живёт без орг/проект понятий | `common/` (logger, env-контракт, validation, external/retry, фильтры, interceptors, sse-relay, `db/`, `storage/` 503-гейт, `crypto/` KEK, `keys/` rotation/store), `health/`, `users/` (профили) + `auth/` (JWT guard/token/password) как sibling | Только NestJS + `pg`/`drizzle` + `zod`. **Ни от кого из ниже не зависит** |
| **Organization** | Тенант. Владелец проектов, мемберства, реестров. Проект существует ТОЛЬКО внутри: `organizations/projects/` | `organizations/` (org CRUD, members, invites), `organizations/registries/` (docker/npm observe-only), `organizations/projects/` (см. §2: access, secrets-override, repository, files, github-link, chats, sessions-persistence) | Только от Common. **Ничего не знает о processes** |
| **Processes** | Выполнение по чужому вызову. Сам не стартует, без владения данными. Вызывается: (1) HTTP-клиентом (фронт) через `AppModule → ProcessesModule → controller` (`sessions/opencode/agents`); контроллер достаёт identity (guard) + `projectId`, проверяет доступ через `organizations/projects/access`, резолвит directory и идёт в runner; (2) `workers/` — событиями/очередью от проектов (пока scaffold, триггеры те же: project-контекст обязателен) | `processes/ai/` (agents, sessions-домен `/api/sessions*`, opencode-транспорт), `processes/workers/` (фоновые задачи, рядом с ai на одном уровне) | От Common + Organization (`projects/access` gate, `repository` путь, `ai-providers`/secrets конфиг). **Никто не зависит от Processes как от библиотеки; Processes зависит от вызова извне** |

Правило чтения таблицы: зависимость идёт **только сверху вниз** (Processes → Organization → Common). Обратная стрелка — ошибка ревью.
Проекты не существуют сами по себе: путь всегда `organizations/projects/`, импорт всегда через `organizations/...`, отдельного верхнего `projects/` нет.
Процессы не существуют сами по себе: у `processes/*` нет входящих импортов из доменов (только `AppModule` монтирует модуль ради HTTP-роутов); вход — HTTP-запрос или событие с `projectId`, а не прямой вызов сервиса из `organizations/projects/*`. Связь `projects/chats → sessions` в текущем коде — это DB-persistence (`project_sessions.chatId`), а не вызов runner.

## 2. Целевая структура

```
src/
├─ main.ts — без изменений (dotenv-expand, setup, validateEnvWithWarnings)
├─ app/                          # СЛОЙ СОХРАНЁН: композиционный корень, не растворяется по доменам
│   ├─ app.module.ts — только сборка графа: Common → Organization (⊃ Projects) → Processes
│   └─ app.setup.ts — без изменений: global prefix 'api', URI-versioning, CORS, Swagger, фильтры (состав сборки тот же)
├─ common/                        # SCOPE: Common (бывший platform/, переименование обратно)
│   ├─ logger/                    # AppLogger + serializeCause
│   ├─ env/                       # env.ts, контракт; секреты — см. §4
│   ├─ validation/                # ZodValidationPipe
│   ├─ external/                  # ExternalClient, retry, EXTERNAL_*
│   ├─ http/                      # api-error.filter, correlation/noindex interceptors + api/ (version, dto)
│   ├─ sse/                       # sse-relay (probe→503, abort downstream, бэкофф)
│   ├─ db/                        # schema.ts, db.module/service, integrity (остаётся в common/)
│   ├─ storage/                   # storage-unavailable.ts (503-гейт) + jail (ex workspaces/modules/path)
│   ├─ crypto/                    # KEK AES-256-GCM — переиспользуемый, вынос из organizations/modules/crypto/
│   └─ keys/                      # rotation/store opencode keys (+ reencrypt) — переиспользуемый, вынос из organizations/modules/keys/
├─ health/                        # без изменений (Common, ни от кого не зависит)
├─ users/                         # Common: профили (UsersService, users.controller)
├─ auth/                          # Common: sibling users/ (jwt-auth.guard, token/password, dto) — вынос из users/auth/
├─ organizations/                 # SCOPE: Organization (владелец projects)
│   ├─ organizations.{module,service,controller}.ts
│   ├─ members/                   # вынос membership из organizations.service
│   ├─ invites/                   # вынос invites
│   ├─ org-projects.controller.ts # тонкая проекция в projects (делегирует, см. §3.4)
│   ├─ registries/                # docker/ + npm/ (observe-only) — часть организаций
│   └─ projects/                  # ПРОЕКТ ВНУТРИ ОРГАНИЗАЦИИ (не верхний уровень)
│       ├─ projects.{module,service,controller}.ts
│       ├─ access/                # assertProjectAccessById (C4-гейт) — единый импорт
│       ├─ secrets/               # scope=project, override поверх organizations/secrets
│       ├─ repository/            # git на диске: clone, tree, submodules, status, catalog (ex workspaces+repos)
│       ├─ files/                 # файлы проекта (ex project-files)
│       ├─ github-link/           # репо GitHub ↔ проект (installation принадлежит орг)
│       ├─ chats/                 # project_chats (FK cascade)
│       └─ sessions/              # project_sessions (+ chat SET NULL) — persistence
├─ processes/                     # SCOPE: Processes (новое; ai и workers на одном уровне)
│   ├─ ai/                        # runtime AI: sessions-домен /api/sessions*, opencode-транспорт, agents
│   │   ├─ sessions/              # доменные /api/sessions* (VERSION_NEUTRAL, 9 роутов)
│   │   ├─ opencode/              # OpencodeService dialUrl, SdkClient, billing/auth + deprecated-зеркало
│   │   └─ agents/                # контроллер агентов
│   └─ workers/                   # фоновые задачи (ex ai/modules/workers/, sibling ai/)
├─ secrets/                       # scope=organization (org-уровень, см. §4; переопределяется в organizations/projects/secrets/)
└─ (legacy: repos/, workspaces/ — схлопнуть в organizations/projects/repository/ + common/storage/ jail, см. фазы)
```

Что переезжает (механика — только `git mv` + правка импортов, логика 1:1):

| Было | Станет | Примечание |
|---|---|---|
| `organizations/modules/crypto/` | `common/crypto/` | Переиспользуемый KEK; `KeysModule`+`auth` импортируют из common |
| `organizations/modules/keys/` | `common/keys/` | Rotation/store переиспользуемый; scope данных остаётся org/project (см. §4), модуль — в common |
| `organizations/modules/projects/` | `organizations/projects/` | Убрать лишний `modules/` уровень; проект внутри организации |
| `ai/modules/` | `processes/ai/` | Весь ai целиком; импорты `ai/**` → `processes/ai/**` |
| `ai/modules/workers/` | `processes/workers/` | На один уровень с ai внутри processes/ |
| `workspaces/modules/path` | `common/storage/` | Jail в common рядом с 503-гейтом |
| `common/api/` (version, dto) | `common/http/api/` | api как часть http-инфры common (бывший platform/http) |
| membership/invites внутри `organizations.service.ts` | `organizations/members/`, `organizations/invites/` | Выделение без смены SQL (таблицы те же) |

Что НЕ переезжает в этом плане: `main.ts`, `contracts.ts` (deprecated-реэкспорт — удаляется только в SDK-миграции, см. `.plans/opencode-sdk-migration/PLAN.md`), `drizzle/` SQL-миграции, `packages/contracts` + `contracts/openapi.yaml` (только сверка имён после переезда).

## 3. Правила зависимостей (ревью-гейт)

0. **Слой `app/` сохраняется.** `app/app.module.ts` (DI-граф) + `app/app.setup.ts` (prefix, versioning, CORS, Swagger) остаются композиционным корнем, не растворяются по доменам. Фазы меняют только состав импортов внутри `AppModule`, сам слой не удаляется.
1. **Common ни от кого не импортирует.** `common/*`, `health`, `users`, `auth` — запрещены импорты из `organizations/`, `processes/`, `repos/`, `workspaces/`. Нарушение = `bun run lint` кастомное правило (см. фазу 8) или ручной grep-гейт `grep -r "from.*organizations" src/common/`.
2. **Organization — только Common.** `organizations/**` может импортировать `common/*`, `users`, `auth` (guard). Запрещены импорты из `processes/`.
3. **Processes — Common + Organization.** `processes/**` может импортировать всё ниже. Запрещено: `organizations/** → processes/**`, `common/** → любой домен`.
4. **`org-projects.controller.ts` — единственное исключение.** Тонкая проекция (делегирует в `ProjectsService` внутри `organizations/projects/`), помечается `// SCOPE-EXCEPTION: projection, delegates only, no logic`.
5. **Processes вызываются извне.** Запрещены прямые импорты `processes/*` из `organizations/**` (кроме монтирования в `AppModule`); вход в Processes — только HTTP (`sessions/opencode/agents` контроллеры) или событие/очередь (`workers/`) с обязательным `projectId` + gate через `organizations/projects/access`. `processes/*` не хранит строки без FK на проекты и не стартует сам.
6. **`WorkspacePathService` — stateless, предоставляется напрямую из `common/storage`.** Чтобы не тянуть `WorkspacesModule` целиком в Organization scope.
7. **C4-гейт единый.** Все проектные роуты идут через `organizations/projects/access/assertProjectAccessById`. Прямые запросы к `project_sessions`/`project_chats` без гейта — нарушение.
8. **Jail единый.** Чтение/запись диска — только через `common/storage` (assertInsideJail) + `REPOS_ROOT`. Прямой `fs` в `organizations/projects/files` или `processes/*` — нарушение (кроме `resolveGithubPrivateKey` в env).

Таблица разрешённых импортов:

| Импортёр \ Импортируемый | common | users/auth | storage/health | organizations (⊃projects) | processes |
|---|---|---|---|---|---|
| common | ✅ | ❌ | ✅ | ❌ | ❌ |
| organizations | ✅ | ✅ | ✅ | ✅ | ❌ (кроме org-projects проекции) |
| processes | ✅ | ✅ | ✅ | ✅ | ✅ |

## 4. Секреты / провайдеры / лимиты

Карта секретов (где живут сейчас → где должны проверяться после реструктуризации; значения не меняются):

| Секрет / конфиг | Scope | Хранение | Поведение без значения (сохранить 1:1) |
|---|---|---|---|
| `OPENCODE_KEYS_ENCRYPTION_KEY` (+ `_PREVIOUS`, `ACTIVE_KEY_ID`, `PREVIOUS_KEY_ID`) | Organization (KEK для secrets) | `common/env` контракт, потребление в `common/crypto` | Пусто → WARN на boot + 500 `opencode_keys_unconfigured` на key-эндпоинтах; короткий explicit → ERROR (значение никогда в лог) |
| `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD` + `OPENCODE_URL`/`TOKEN` | Processes-транспорт (`processes/ai/opencode`) | `common/env`, потребление в `OpencodeService`/`OpencodeAuthService` | Пусто → WARN + upstream 401 (честный сигнал); dial `0.0.0.0 → 127.0.0.1` в `dialUrl` сохранить |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` (+ TTL) | Common (`auth/`) | `common/env`, потребление в token service | Пусто → ephemeral dev secret + boot WARN; explicit < 32 → ERROR |
| `GITHUB_APP_ID` + `PRIVATE_KEY`/`PATH` (+ `INSTALLATION_ID` legacy, `SLUG`, `WEBHOOK_SECRET`, `API_URL`) | Project (`organizations/projects/github-link`, installation в орг) | `common/env`, потребление в github service | Половинчатая пара → ERROR; пусто → WARN + 401/503; legacy install → WARN deprecated |
| `DOCKER_REGISTRY_*` (URL/USER/PASSWORD/TOKEN/timeout/retry) | Organization (`organizations/registries/docker`) | `common/env`, потребление в docker module | Пусто URL → WARN + 503 + health `skipped`; половинчатая basic-пара → WARN + anonymous |
| `NPM_REGISTRY_*` (URL/TOKEN legacy `NPM_TOKEN`/USER/PASSWORD/SCOPE/timeout/retry) | Organization (`organizations/registries/npm`) | `common/env`, потребление в npm module | Пусто URL → WARN + 503 + `skipped`; приоритет TOKEN > basic > anonymous сохранить |
| `DATABASE_URL` / `POSTGRES_*` | Common (`common/db`) | `common/env` | Пусто → WARN + 503 `EXTERNAL_UNAVAILABLE` на pg-операциях; compose из `POSTGRES_*` сохранить |
| `REPOS_ROOT` (+ legacy `PROJECTS_ROOT`) | Common-гейт (`common/storage`), исполнение в `organizations/projects/repository/` | `common/env` | Пусто → boot ERROR-лог + reads 503 / creates 500; без fallback на `<cwd>/repos` (fail-fast, см. AGENTS.md) |
| `CORS_ORIGINS`, `NEXT_PUBLIC_*`, `REQUEST_TIMEOUT_MS`, `EXTERNAL_RETRY_*`, `LOG_LEVEL` | Common | `common/env` | Дефолты-тюнинг чтения сохранить (см. env.ts readonly-исключения), мусор → ERROR/WARN как сейчас |

Провайдеры (DI):

| Провайдер | Scope | Доступ |
|---|---|---|
| `AppLogger` | Common | Global (через `common/logger` или `CommonModule`-совместимость на переход) |
| `DbService` (`DbModule`) | Common | Global/импорт везде; единственный доступ к `pg`/`drizzle` |
| `UsersService` (`UsersModule` global) | Common | Без импорта (как сейчас в `OrganizationsModule` — не импортировать, нет цикла) |
| `CryptoService` | Common (переиспользуемый) | Экспорт из `common/crypto`, импорт в `common/keys` + `auth` + `organizations/secrets` |
| `WorkspacePathService` | Common (`common/storage`) | `provided directly` (stateless), не тянет весь `WorkspacesModule` |
| `OpencodeService` / `OpencodeSdkClient` / `OpencodeBillingService` | Processes-транспорт (`processes/ai/opencode`) | Реэкспорт через `ProcessesModule`/`AiModule`; потребители — только Processes scope |

Лимиты (не менять в этом плане, только сохранить проводку):

- `REQUEST_TIMEOUT_MS` (default 10000), `EXTERNAL_RETRY_*` (3 / 200 / 2000), registry-таймауты (10000) и retry (3/200/2000) — дефолты и `retryInt`/`timeoutSchema` валидация 1:1.
- JWT TTL: access 900s / refresh 604800s.
- KEK: `MIN_*_LENGTH = 32`, `KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`.
- Логи: только `AppLogger`, normal path без стеков/секретов/PII/URL/body/Bearer; e2e-скан секретов (эталон `opencode-keys.e2e.ts`) обязан остаться зелёным.

## 5. Фазы 0–9

### Фаза 0. Инвентаризация (read-only, без кода)

- Снять фактический граф импортов: `graphify` / `scripts/graphify/run.sh` (`pattern: src/**/*.ts`) + ручной `grep` на `from.*\.\./` через границы scope.
- Сверить `ARCHITECTURE.md` с фактом (legacy `api/`, `docker-registry/`, `npm-registry/` — живы или уже переехали в `organizations/modules/registries`).
- Зафиксировать список контроллеров/роутов до переезда (swagger snapshot / `versioning.e2e.ts` ожидания).
- Выход: таблица «модуль → scope → переезжает/остаётся» + список циклических импортов (если есть).
- Гейт: `bun run lint` + `bun run build` зелёные до старта (база).

### Фаза 1. Common: консолидация `common/` (без переименований в platform)

- `common/crypto` ← `organizations/modules/crypto`, `common/keys` ← `organizations/modules/keys` (`git mv`, переиспользуемые).
- `common/storage` ← `workspaces/modules/path` (jail) + уже лежащий `storage-unavailable.ts` (503-гейт) рядом.
- `common/http/api` ← `common/api` (version, dto) — api как часть http-инфры.
- `app.module.ts` — проводка остаётся на `CommonModule` (без platform-шима, т.к. platform→common откат).
- Гейт: lint + build + `test:e2e:auth` (guard/validation затронуты).

### Фаза 2. Common: `auth/` sibling + `storage/`/`health` фиксация

- `git mv users/auth → auth/`; `AuthModule` импортируется в `AppModule` напрямую; `UsersModule` остаётся global.
- Проверить отсутствие цикла `auth ↔ users` (auth — только `DbService` + token/password, users — только `DbService`).
- `storage/`, `health/` — без переезда, добавить scope-комменты в module-файлы (`// SCOPE: Common`).
- Гейт: lint + build + `test:e2e:auth`.

### Фаза 3. Organization: консолидация `organizations/`

- Выделить `organizations/members/` и `organizations/invites/` из `organizations.service.ts` (сервисы + контроллерные методы переезжают, SQL/таблицы те же: `organization_members` partial unique single-maintainer, `organization_invites` token-PK single-use).
- `common/crypto`, `common/keys` — уже в common (фаза 1), добавить scope-комменты; `KeysModule` путь обновить в зависимых (совместимость с `.plans/opencode-sdk-migration` spike — только пути).
- `WorkspacePathService` — сохранить `provided directly`, задокументировать в module-комменте.
- Гейт: lint + build + `test:e2e:github` (install/membership задеты) + `test:e2e:opencode-keys` (KEK/keys).

### Фаза 4. Organization⊃Project: консолидация `organizations/projects/`

- `organizations/modules/projects → organizations/projects/` (убрать лишний `modules/` уровень; целиком: `projects.module/service/controller` + `files,github-link,sessions,chats,repository,access,secrets`).
- `organizations/org-projects.controller.ts` — ужать до проекции (делегация в `ProjectsService` внутри `organizations/projects/`, пометка `SCOPE-EXCEPTION`).
- `OrganizationsModule`: владеет `ProjectsModule` (проект внутри организации — допустимая стрелка вниз). Обратное (`ProjectsModule → OrganizationsModule` ради гейта) запрещено — gate живёт в `organizations/projects/access/`.
- Выделить `organizations/projects/access/` (C4-гейт) — все контроллеры `organizations/projects/*` идут через него.
- Гейт: lint + build + `test:e2e:projects` + `test:e2e:repos`.

### Фаза 5. Исполнители: `processes/` + `organizations/projects/repository/` привязка

- `ai/ → processes/ai/` (`git mv` целиком: sessions, opencode, agents); `ai/modules/workers/ → processes/workers/` (sibling ai внутри processes/).
- `repos/` + `workspaces/` → схлопнуть в `organizations/projects/repository/` (clone/tree/submodules/status/catalog) + jail в `common/storage`; зафиксировать jail-контракт: `REPOS_ROOT/<space>/workspace/<repo>`, `assertInsideJail` на каждый вход, `storage-unavailable` 503-гейт.
- Удалить прямые `fs`-доступы вне `repository/`/`common/storage/` (grep-гейт), кроме `resolveGithubPrivateKey` в env.
- `processes/ai`: ни один сервис не хранит строки без FK на `projects(id)` (сверить `project_sessions`/`session_messages` планы SDK-миграции — foreign keys `ON DELETE CASCADE`, `parent_session_id SET NULL`).
- Гейт: lint + build + `test:e2e:repos` + `test:e2e:opencode-keys` (скан секретов).

### Фаза 6. Решения до старта (§6) — зафиксировать письменно

- Закрыть все 7 вопросов из §6 до первого `git mv` (особенно направление `OrganizationsModule ↔ ProjectsModule` и судьба `CommonModule`-шима).
- Выход: апдейт этого PLAN.md (таблица решений: принято/дата) — без этого фаза 1 не начинается.

### Фаза 7. Контракты и swagger-сверка

- `packages/contracts` (12 пар) + `contracts/openapi.yaml` — только сверка: пути/DTO не меняются при переезде (переезд — внутренний, wire-контракт тот же).
- `contracts.ts` реэкспорт — не трогать (удаление — только в SDK-миграции).
- `versioning.e2e.ts` + `app.setup.ts` (prefix `api`, versioning) — без изменений; прогнать `test:e2e` полностью как сверку.
- Гейт: полный `bun run test:e2e` зелёный.

### Фаза 8. Гейты: lint/build/e2e + grep-гейты границ

- `bun run lint` (`tsc --noEmit` + `biome`) + `bun run build` — обязательно после каждой фазы.
- Добавить grep-гейты (временно руками, постоянные — по решению §6.7):
  - `grep -rn "from.*organizations" src/common/` → пусто;
  - `grep -rn "from.*processes" src/organizations/ --exclude=org-projects.controller.ts` → пусто;
  - `grep -rn "from.*cwd.*repos\|__dirname.*repos" src/organizations src/processes` → пусто (jail-контракт).
- `db:check-integrity` (Drizzle schema-integrity) после фаз 1/4.
- Полный `bun run test` (юнит из `dist`) + `bun run test:e2e`.

### Фаза 9. Чистка и документы

- Удалить legacy `repos/`, `workspaces/`, `ai/` верхние dirs — только когда ноль импортов (`grep -rn "from.*repos/\|from.*workspaces/\|from.*ai/modules" src/ | wc -l == 0`).
- Обновить `apps/backend/ARCHITECTURE.md` (новое дерево `src/`) + `apps/backend/AGENTS.md` (scope-правила коротко) + корневой `AGENTS.md` при необходимости.
- Обновить `.plans/opencode-sdk-migration/PLAN.md` пути (`src/opencode` → `src/processes/ai/opencode`, `src/sessions` → `src/processes/ai/sessions`, `src/projects/sessions` → `src/organizations/projects/sessions`, `src/db` → `src/common/db`, `src/ai/modules/workers` → `src/processes/workers`) — только пути, без смены смысла.
- Финальный прогон: lint + build + test + test:e2e + `db:check-integrity`.

## 6. Решения до старта (закрыть до фазы 1)

| # | Вопрос | Опции | Дефолт (если не решат) |
|---|---|---|---|
| 6.1 | Вложенность `organizations/projects` | (a) Проект только внутри `organizations/projects/`; (b) верхний `projects/` | (a) — принято правкой v2 |
| 6.2 | Судьба `CommonModule` | (a) Оставить как есть (platform→common откат, шим не нужен); (b) шим-реэкспорт | (a) |
| 6.3 | Резать ли `env.ts` (~1200 строк) в этом плане | (a) Не резать — остаётся `common/env`; (b) разбить по scope-файлам | (a) — разбивка отдельным планом |
| 6.4 | `org-projects.controller.ts` — оставить или удалить | (a) Оставить проекцией с `SCOPE-EXCEPTION`; (b) удалить, фронт ходит напрямую в `/projects` | (a) — wire-контракт не меняем |
| 6.5 | `session_messages` / fork-поля — в этом плане? | (a) Нет — только в SDK-миграции; (b) да | (a) — схема БД здесь не меняется, миграции только в SDK-плане |
| 6.6 | `contracts.ts` + `packages/contracts` трогать? | (a) Нет, только сверка фазы 7; (b) чистить | (a) |
| 6.7 | Grep-гейты — руками или в CI | (a) Руками до фазы 9, затем решить; (b) сразу в `scripts/check` | (a) |

### 6.8 Решения зафиксированы (2026-11-01, подтверждено пользователем)

| # | Решение | Статус |
|---|---|---|
| 6.1 | Проект только внутри `organizations/projects/` | Принято 2026-11-01 |
| 6.2 | `CommonModule` остаётся как есть, шим не вводится | Принято 2026-11-01 |
| 6.3 | `common/env/env.ts` в этом плане не режем | Принято 2026-11-01 |
| 6.4 | `org-projects.controller.ts` остаётся тонкой проекцией с `SCOPE-EXCEPTION` | Принято 2026-11-01 |
| 6.5 | `session_messages`/fork-поля — только в SDK-миграции | Принято 2026-11-01 |
| 6.6 | `contracts.ts` + `packages/contracts` — только сверка (фаза 7) | Принято 2026-11-01 |
| 6.7 | Grep-гейты руками до фазы 9 | Принято 2026-11-01 |

Дополнительно принято (не входило в §6, найдено в фазе 0):

| Вопрос | Решение | Статус |
|---|---|---|
| `health/` импортирует `ai/opencode` + `organizations/registries` | Инверсия через `common/health/health-registry.ts`: доменные модули сами регистрируют пробу (`OnModuleInit`), health не импортирует домены | Сделано (фаза 1B, commit `278df2d`) |
| `keys.controller.ts` (в common) импортирует `ai/.../billing` | Store/rotation остаются в `common/keys`, HTTP-поверхность (`/api/v1/key`, `/api/v1/usage`) вынесена в `ai/modules/opencode` | Сделано (фаза 1B) |
| `storage/storage-unavailable.spec.ts` импортирует домены | Спека вынесена в `organizations/__tests__/` (common не импортирует домены) | Сделано (фаза 1A) |
| `.gitignore: keys/` глотает `src/**/keys/` | Корневой паттерн `keys/` → `/keys/` (+ `*.pem` остаётся) | Сделано (фаза 1B) |
| Pre-existing red: `crypto` empty-plaintext round-trip | Guard `raw.length <= TAG_BYTES` → `<` (auth-tag проверка не ослаблена) | Сделано (фаза 1B) |

## 7. Риски

| Риск | Где | Митигация |
|---|---|---|
| Циклический импорт при выносе (`organizations ↔ projects`, `auth ↔ users`) | Фазы 2, 4 | `git mv` малыми коммитами (по одному scope за коммит), после каждого — `tsc --noEmit`; направление фиксировано в §6.1; `UsersService` global без импорта |
| Тихий fallback при резке env/jail | Фазы 1, 5 | `env.ts` не режем (§6.3); jail-grep-гейт фазы 8; без `REPOS_ROOT` — те же 503/500, e2e `storage-unconfigured` (`corrupted` на list/get) |
| Потеря KEK-проводки (`active/previous` keyId) | Фаза 3 | Таблицы/SQL не меняем; `keys:reencrypt` + `opencode-keys.e2e.ts` (скан секретов/форм логов) — гейт каждой фазы с keys |
| Сломан wire-контракт (фронт/mobile) | Фазы 4, 5, 7 | Роуты/DTO/swagger не меняем; фаза 7 — полный e2e + сверка `openapi.yaml` диффом `git diff --stat` (должен быть пустым по контрактам) |
| Конфликт с SDK-миграцией (параллельные переезды `ai/*`, `sessions`, `db/schema`) | Все фазы | Этот план — только `git mv` + границы, без логики; SDK-план — логика/БД. Пути SDK-плана обновить в фазе 9; не стартовать оба плана в одних файлах одновременно — сначала этот (границы), затем SDK (логика) |
| Раздутый `app.module.ts` / DI-граф | Фазы 1–2 | Импорты только верх→низ (§3); `WorkspacePathService` из `common/storage` напрямую; без `platform/`-шима |
| Потеря provenience (`contracts/opencode-stand-*.json`, `.env.example`) | Фаза 9 | `.env.example`/README правим сразу как код (по AGENTS.md); stand-артефакты не удаляем молча — архивировать |

## 8. Критерии готовности

- Дерево `src/` соответствует §2 (проверка `ls`: `common/crypto|keys|storage`, `auth/` sibling, `organizations/projects/`, `organizations/members|invites`, `processes/ai|workers`).
- Ноль импортов против стрелки (§3, три grep-гейта пустые).
- Legacy `repos/`, `workspaces/`, `ai/` удалены, ноль `from.*repos/|workspaces/|ai/modules` импортов.
- Wire-контракт не изменился: `git diff` по `packages/contracts/`, `contracts/openapi.yaml`, `contracts.ts` — пустой (кроме путей в комментах SDK-плана фазой 9).
- `bun run lint` + `bun run build` зелёные; `bun run test` + полный `bun run test:e2e` зелёные; `bun run db:check-integrity` зелёный; e2e-скан секретов чистый.
- `ARCHITECTURE.md` + `AGENTS.md` обновлены; пути в `.plans/opencode-sdk-migration/PLAN.md` актуализированы.
- Без `REPOS_ROOT` — те же 503/500 + `corrupted`; без `DATABASE_URL` — 503; без KEK — 500 `opencode_keys_unconfigured` (поведение 1:1, проверено e2e).

## 9. Дальше (вне скоупа этого плана)

- Разбивка `common/env/env.ts` по scope-файлам (отдельный план, высокий риск silent fallback).
- Постоянные lint-гейты границ (eslint-plugin-boundaries или кастом в `scripts/check/run.sh`).
- SDK-миграция (`.plans/opencode-sdk-migration/PLAN.md`): embedded host, свои сессии в Postgres, удаление HTTP-зеркала — стартует после этого плана (границы уже чистые).
- Удаление `contracts.ts`-реэкспорта и `contracts/opencode-stand-*.json` архивация — в SDK-плане, не здесь.
- CI-гейты scope (по решению §6.7).

## Приложение A. Проверка после каждой фазы (шпаргалка)

```bash
bun run lint
bun run build
bun run db:check-integrity
# точечные e2e по фазе: :auth / :projects / :repos / :github / :opencode-keys
bun run test:e2e:auth
# grep-гейты границ:
grep -rn "from.*organizations" apps/backend/src/common/ || echo OK-common
grep -rn "from.*processes" apps/backend/src/organizations/ --include="*.ts" | grep -v org-projects || echo OK-org
grep -rn "from.*common/" apps/backend/src/ | wc -l
```
