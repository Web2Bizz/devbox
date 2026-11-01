# ARCHITECTURE.md

## Структура модулей

Три scope-слоя: **Processes → Organization (⊃ Project) → Common**. Стрелка
зависимостей идёт только вниз; вверх импортов нет (grep-гейты, план
`.plans/backend-domain-restructure/PLAN.md` §3).

```
src/
├─ main.ts — бутстрап (dotenv-expand, configureApp/setupSwagger, validateEnvWithWarnings)
├─ contracts.ts — deprecated-реэкспорт @rush-code/contracts (не расширять)
├─ bun.d.ts — типы Bun-рантайма (Bun.randomUUIDv7)
├─ app/ — app.module.ts (Common → Health → Organizations → Users → Auth → Processes),
│         app.setup.ts (global prefix 'api' + URI-versioning + CORS + swagger)
├─ common/ — ОДИН @Global-модуль (common.module.ts); один общий слой, не домен
│  ├─ logger/ — AppLogger + serializeCause (index.ts)
│  ├─ env/ — validateEnv / validateConfigForNest (env.ts, REPOS_ROOT)
│  ├─ validation/ — ZodValidationPipe (index.ts)
│  ├─ external/ — ExternalClient, retry, ExternalServiceError (коды EXTERNAL_*)
│  ├─ http/ — api-error.filter.ts, correlation/noindex interceptor'ы, api/{dto,version}.ts
│  ├─ sse/ — sse-relay.ts (probe до заголовков → 503, abort downstream, бэкофф)
│  ├─ db/ — DbService (drizzle+pg, dbUnavailable → 503), schema.ts, schema-integrity, e2e-db
│  ├─ storage/ — WorkspacePathService (единственный jail поверх REPOS_ROOT),
│  │            storage-unavailable.ts (единый 503-гейт без корня)
│  ├─ crypto/ — CryptoService (AES-256-GCM, версионные KEK)
│  ├─ keys/ — OpencodeKeysService (store + rotation, только ciphertext), keys.reencrypt, keys.schema
│  └─ health/ — HealthRegistry (реестр проб; домены регистрируются сами)
│     (в подпапках common/ нет *.module.ts — это группы утилит, CoC §3)
├─ health/ — GET /health + /api/v1/health (только DbService + HealthRegistry)
├─ users/ — профили: UsersModule (@Global: UsersService, PasswordService), users.controller (/users)
├─ auth/ — sibling users/: auth.controller (/auth: register/login/refresh/logout/me),
│         jwt-auth.guard, token/identity services, auth-provider, req-user.decorator
├─ organizations/ — SCOPE: Organization
│  ├─ organizations.{module,service,controller}.ts, organizations.types.ts, organizations.dto.ts
│  ├─ organizations.guard.ts — реальный CanActivate (GET = member, мутации = maintainer;
│  │                           навешан на gated-роуты OrganizationsController)
│  ├─ modules/members/ — MembersModule / MembersService
│  ├─ modules/invites/ — InvitesModule / InvitesService (uuidv7 через Bun.randomUUIDv7)
│  ├─ modules/registries/ — RegistriesModule: modules/docker/ + modules/npm/ (observe-only)
│  ├─ modules/projects/ — SCOPE: Project, ОДИН контроллер на модуль (projects.controller.ts)
│  │  ├─ projects.{module,service}.ts, projects.dto.ts
│  │  ├─ modules/project-access/ — ProjectAccessService (гейт C4: org-linked → member,
│  │  │                            user-space → owner, stranger → 404 без утечки)
│  │  ├─ modules/repository/ — repository.module.ts (git-поверхность проекта)
│  │  │  ├─ modules/repos/ — REPOS_ROOT-реестр репозиториев (/repos)
│  │  │  ├─ modules/workspaces/ — per-user surface (/workspaces) + modules/clone/ (CloneModule)
│  │  │  └─ utils/{repos-git,submodules}/ — pure-хелперы (index.ts + __tests__)
│  │  ├─ modules/files/ — project-files (чтение/запись строго внутри jail)
│  │  ├─ modules/github/ — app/installations/link + utils/webhook/
│  │  ├─ modules/chats/ — чаты проекта (/projects/:projectId/chats)
│  │  └─ modules/sessions/ — project_sessions (/projects/:projectId/sessions)
│  ├─ utils/{organization-member,pg-error}/ — pure-хелперы (index.ts + __tests__)
│  └─ __tests__/ — organizations.e2e, organizations.guard.spec, storage-unavailable.spec
└─ processes/ — SCOPE: Processes
   ├─ processes.module.ts
   └─ modules/ai/ — ai.module.ts
      ├─ modules/agents/ — AgentBase/AskAgent + /agents
      ├─ modules/opencode/ — deprecated-зеркало /opencode/* + транспорт раннера
      │  ├─ opencode.{controller,service}.ts, opencode-sdk-client.ts (lazy @opencode-ai/sdk/v2)
      │  ├─ keys.controller.ts — HTTP /api/v1/key + /api/v1/usage (store — в common/keys)
      │  └─ modules/{auth,billing}/ — OpencodeAuthService (gate + Basic), OpencodeBillingService
      └─ modules/sessions/ — доменный /api/sessions* (VERSION_NEUTRAL, SSE через common/sse)
   └─ modules/workers/ — workers.module.ts
```

Примечание про `organizations/org-projects.controller.ts`: проекции больше
нет — оба набора роутов живут в единственном `projects.controller.ts`
(`/organizations/:id/projects*` и `/projects*`). Wire-контракт не менялся.

## Правила зависимостей

- Стрелка одна: `processes → organizations → common`. Обратных импортов нет.
- `common/` не знает о доменах: ни `organizations/`, ни `processes/`, ни `users/`,
  ни `auth/`. `common/health/health-registry.ts` — инверсия: пробы
  регистрируются самими доменами в `OnModuleInit`.
- `organizations/` не импортирует `processes/` (в т.ч. `ai`): общие куски
  выносятся в `common/`.
- `users/` — `@Global()`, но сам не импортирует `auth/` (граф остаётся ацикличным);
  `auth/` — sibling, читает `UsersService`/`PasswordService` через global-модуль.
- Вложенные модули наружу не экспортируются: торчит только родительский домен
  (CoC §2). `ProjectsModule` не импортирует `OrganizationsModule` — гейт закрыт
  через `ProjectAccessModule`.

## Storage: один корень и один jail

`REPOS_ROOT` — единственный источник правды для чтения И записи
(`REPOS_ROOT/(users|orgs)/<scopeId>/projects/<projectId>/content[/subPath]`). Без него — отказ: чтения 503
`EXTERNAL_UNAVAILABLE`, создание проектов 500; boot продолжается с логом ERROR.
Фолбэков на `cwd`/`__dirname` нет (grep-гейт).

Весь fs-доступ идёт через `common/storage/workspace-path.service.ts`:
`resolveRoot/resolveUserStrict/resolveOrgStrict`, `assertInsideJail`,
`ensureDir/removeDir/statPath/readDir`. Прямой `node:fs` допустим только в
`common/{env,db,storage}` и `organizations/.../repository/**` (git-инспекция
репозитория), вне тестов.

## Раскладка CoC v2

- `<domain>/` — `<domain>.module|controller|service|dto.ts`, `utils/`, `__tests__/`.
- Вложенный Nest-модуль — `<parent>/modules/<sub>/` со своим набором файлов.
  Соседние папки-«модули» (`<parent>/<sub>/`) запрещены.
- `utils/<name>/` — свой `index.ts` (публичная поверхность) + собственные
  `__tests__/`; соседний плоский `<name>.util.ts` без папки запрещён.
- Тесты: `__tests__/` рядом с кодом (`*.spec.ts` — юнит, `*.e2e.ts` — e2e).
- DI-зависимости в конструкторах — `private readonly` (CoC §5).
- uuidv7 — только `Bun.randomUUIDv7()` (runtime Bun), своего util нет.

## Поток одного запроса

`JwtAuthGuard` → гейт `ProjectAccessService` (`assertProjectAccess` /
`assertProjectAccessById`: org-linked → member, user-space → owner,
stranger → 404 без утечки существования) → jail (`WorkspacePathService` поверх
`REPOS_ROOT`) → upstream к runner: sdk (`OpencodeSdkClient`) для полей, которые
генератор НЕ режет, иначе сырой `fetchWithRetry` + `serveBasicAuthHeader` →
маппинг сбоя в `EXTERNAL_*` (`external-error.ts`) → `ApiErrorFilter` в
`ApiError`-envelope (+`x-correlation-id`) — normal path однострочник
`[http] handled`, без стеков/секретов.
