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
├─ app/ — app.module.ts (Common → Health → Organizations → Users → Auth → Vault → Processes),
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
│  ├─ canonical-json/ — canonicalJson (детерминированный JSON: сортировка ключей, для content-хешей)
│  ├─ crypto/ — CryptoService (AES-256-GCM, версионные KEK)
│  ├─ vault/ — VaultRepository + VaultService (per-consumer user|org secret store, AES-256-GCM,
│  │            round-robin), vault.reencrypt, vault.providers
│  ├─ health/ — HealthRegistry (реестр проб; домены регистрируются сами)
│  └─ zen/ — JevService / SessionRunnerService (Zen-модели через ExternalClient, ключи из common/vault)
│     (в подпапках common/ нет *.module.ts — это группы утилит, CoC §3)
│     (корневые файлы common/ — только *.filter.ts, *.interceptor.ts, *.module.ts, sse-relay.ts; CoC §3)
├─ health/ — GET /health + /api/v1/health (только DbService + HealthRegistry)
├─ users/ — профили: UsersModule (@Global: UsersService), users.controller (/users), utils/password (argon2id)
├─ auth/ — sibling users/: auth.controller (/auth: register/login/refresh/logout/me),
│         jwt-auth.guard, token/identity services, auth-provider, req-user.decorator
├─ vault/ — SCOPE: Vault (per-consumer secrets: user | org)
│  ├─ vault.module.ts, vault.controller.ts — /api/v1/vault/secrets* (current user)
│  ├─ modules/organizations/ — VaultOrganizationsController/Module
│  │                           (/api/v1/vault/organizations/:orgId/secrets*; member read, maintainer mutate)
│  ├─ utils/secret-view/ — ownUserId/isUserId (fail-closed uuid), toInfo
│  │                       (pure-хелпер, общий для обоих контроллеров; index.ts + __tests__)
│  ├─ vault.dto.ts
│  └─ __tests__/ (vault.controller.spec, vault.e2e)
├─ organizations/ — SCOPE: Organization
│  ├─ organizations.{module,service,controller}.ts, organizations.types.ts, organizations.dto.ts
│  ├─ organizations.guard.ts — реальный CanActivate (GET = member, мутации = maintainer;
│  │                           навешан на gated-роуты Organizations/Members/Invites)
│  ├─ modules/members/ — MembersModule / MembersService / members.controller.ts (/organizations/:id/members*)
│  ├─ modules/invites/ — InvitesModule / InvitesService (uuidv7 через Bun.randomUUIDv7),
│  │                     invites.controller.ts (/organizations/:id/invites, /organizations/invites/accept)
│  ├─ modules/registries/ — RegistriesModule: modules/docker/ + modules/npm/ (observe-only)
│  ├─ modules/projects/ — SCOPE: Project; два контроллера по сущностям (CoC §1.1):
│  │  ├─ projects.controller.ts (/projects*), org-projects.controller.ts (/organizations/:id/projects*)
│  │  ├─ projects.{module,service}.ts, projects.dto.ts
│  │  ├─ modules/project-access/ — ProjectAccessService (гейт C4: org-linked → member,
│  │  │                            user-space → owner, stranger → 404 без утечки)
│  │  ├─ modules/repository/ — repository.module.ts (git-поверхность проекта)
│  │  │  ├─ modules/repos/ — REPOS_ROOT-реестр репозиториев (/repos)
│  │  │  ├─ modules/workspaces/ — per-user surface (/workspaces) + modules/clone/ (CloneModule)
│  │  │  │  └─ modules/clone/utils/repo-url/ — pure-хелпер (index.ts + <name>.util.ts + __tests__)
│  │  │  └─ utils/{repos-git,submodules}/ — pure-хелперы (index.ts + __tests__)
│  │  ├─ modules/files/ — project-files (чтение/запись строго внутри jail)
│  │  ├─ modules/github/ — app/installations/link + utils/{app-state,webhook}/
│  │  ├─ modules/chats/ — чаты проекта (/projects/:projectId/chats)
│  │  └─ modules/sessions/ — project_sessions (/projects/:projectId/sessions)
│  ├─ utils/{organization-member,pg-error}/ — pure-хелперы (index.ts + __tests__)
│  └─ __tests__/ — organizations.e2e, organizations.guard.spec, storage-unavailable.spec
└─ processes/ — SCOPE: Processes
   ├─ processes.module.ts
   ├─ modules/ai/ — ai.module.ts
   │  ├─ modules/agents/ — AgentBase/AskAgent + /agents
   │  ├─ modules/opencode/ — встроенный OpenCode V2 host + billing
   │  │  ├─ opencode-host.service.ts (in-process @opencode/sdk, без листенера и HTTP-контроллера)
   │  │  └─ modules/{auth,billing}/ — ServeAuthService (Basic для хоста), BillingService + BillingController (HTTP /api/v1/usage)
   │  ├─ modules/sessions/ — доменный /api/v1/sessions* (URI-versioned v1, SSE через common/sse)
   │  │  ├─ modules/{events,inventory,messaging,recorder,revert,runner,snapshots,state,workspace}/ — внутренние зоны сессии
   │  │  └─ utils/{session-commands,session-errors,session-providers}/ — pure-хелперы (index.ts + <name>.util.ts + __tests__)
   │  ├─ modules/tool-runtime/ — tool-runtime.module.ts (ToolRuntimeModule: импортирует+экспортирует ToolRegistryModule/ToolDispatchModule; контракты + registry + dispatch, хендлеров не держит)
   │  │  ├─ tool-runtime.types.ts — ToolMode/ToolContext/Definition/Handler/Call/Settlement + toolLabel (общие контракты тулов)
   │  │  ├─ modules/tool-registry/ — ToolRegistryModule → ToolRegistryService (каталог name→handler, listForPrompt) + __tests__
   │  │  └─ modules/tool-dispatch/ — ToolDispatchModule → ToolDispatchService (bounded dispatch + ask-gate + идемпотентные effects) + __tests__
   │  └─ modules/tools/ — tools.module.ts (ToolsModule: импортирует ToolRuntimeModule; providers = WorkspacePathService + 8 *.tool.ts + ToolsBootstrapService, экспортов нет)
   │     ├─ tools.bootstrap.ts — регистрирует 8 хендлеров в ToolRegistryService из ToolRuntimeModule
   │     ├─ utils/{glob-match,tool-jail,tool-walk,langchain-tools}/ — pure-хелперы (index.ts + <name>.util.ts + __tests__)
   │     └─ __tests__/tool-patch.spec.ts
   ├─ modules/runs/ — доменный /api/v1/runs* (RunInfo/CreateRunRequest, SSE-журнал run_events, URI-versioned v1)
   └─ modules/workers/ — in-process run engine (без HTTP-роутов)
      ├─ modules/claim-loop/ — RunsClaimLoop (llm.call → tool.call → sandbox.exec → git.commit)
      ├─ modules/executor/ — Executor + ExecutorRegistry
      ├─ modules/git/ — RunWorktreeService (git.commit)
      ├─ modules/model-gateway/ — ModelUsage + провайдер модели
      ├─ modules/sandbox/ — SandboxProvider (exec)
      ├─ modules/skills/ — skills loader + frontmatter
      ├─ modules/tool-registry/ — worker-owned tool registry + MCP client
      └─ utils/step-plan/ — pure step planner (index.ts + <name>.util.ts + __tests__)
```

Примечание про `organizations/modules/projects/`: одна сущность — один
контроллер (CoC §1.1). `projects.controller.ts` держит `/projects*`,
`org-projects.controller.ts` — `/organizations/:id/projects*` (включая
410-заглушки attach/detach). Wire-контракт не менялся: URL, методы,
коды и Swagger-теги прежние.

## Правила зависимостей

- Стрелка одна: `processes → organizations → common`. Обратных импортов нет.
- `common/` не знает о доменах: ни `organizations/`, ни `processes/`, ни `users/`,
  ни `auth/`. `common/health/health-registry.ts` — инверсия: пробы
  регистрируются самими доменами в `OnModuleInit`.
- `organizations/` не импортирует `processes/` (в т.ч. `ai`): общие куски
  выносятся в `common/`.
- `users/` — `@Global()`, но сам не импортирует `auth/` (граф остаётся ацикличным);
  `auth/` — sibling, читает `UsersService` через global-модуль, а `verifyPassword` — из `users/utils/password` напрямую.
- Вложенные модули наружу не экспортируются: торчит только родительский домен
  (CoC §2). `ProjectsModule` не импортирует `OrganizationsModule` — гейт закрыт
  через `ProjectAccessModule`.
- `vault/` — HTTP-домен поверх общего механизма: `vault → auth`
  (`JwtAuthGuard`, `ReqUser`) и `vault → organizations` (`OrganizationsGuard`)
  — разрешённые стрелки вниз; обратных импортов нет, `processes/` не
  импортируется. Секреты читаются только через `VaultService`.
- `common/vault/` не знает о доменах (ни `users/`, ни `organizations/`,
  ни `auth/`) — только `db`-схема `vault_secrets` + `CryptoService`.
  `VaultService`/`VaultRepository` — глобальные через `CommonModule`, поэтому
  `zen/` и `billing/` инжектят их без явного импорта.
- Внутри `ai/modules/` контракты тулов вынесены в sibling `tool-runtime/`:
  `sessions → tool-runtime` (runner инжектит `ToolDispatchService`),
  `tools → tool-runtime` (bootstrap пишет хендлеры в `ToolRegistryService`), а
  `tool-runtime/` не импортирует `tools/` и `sessions/` — только свои контракты.
  `ai.module.ts` собирает `ToolsModule` (bootstrap) + `SessionsModule`, сам
  `ToolRuntimeModule` не импортирует.

## Storage: один корень и один jail

`REPOS_ROOT` — единственный источник правды для чтения И записи
(`REPOS_ROOT/orgs/<scopeId>/projects/<projectId>/content[/subPath]`; org-only —
легаси-ветка `users/` в резолвере не используется). Без него — отказ: чтения 503
`EXTERNAL_UNAVAILABLE`, создание проектов 500; boot продолжается с логом ERROR.
Фолбэков на `cwd`/`__dirname` нет (grep-гейт).

Весь fs-доступ идёт через `common/storage/workspace-path.service.ts`:
`resolveRoot`, `realRoot/realStrictRoot`,
`requireExplicitRoot/isExplicitRootConfigured`,
`resolveOrg/resolveOrgStrict/orgScopeStrict/ensureOrgScope/ensureProjectDirs`,
`assertInsideJail`, `checkUuid`,
`ensureDir/removeDir/statPath/readDir/readFile/writeFile`. Прямой `node:fs` допустим только в
`common/{env,db,storage}` и `organizations/.../repository/**` (git-инспекция
репозитория), вне тестов.

## Раскладка CoC v2

- `<domain>/` — `<domain>.module|controller|service|dto.ts`, `utils/`, `__tests__/`.
- Вложенный Nest-модуль — `<parent>/modules/<sub>/` со своим набором файлов.
  Соседние папки-«модули» (`<parent>/<sub>/`) запрещены.
- `utils/<name>/` — `index.ts` (публичная поверхность) + `<name>.util.ts`
  (реализация, только чистые функции) + собственные `__tests__/`; плоский
  `<name>.util.ts` без папки и `utils/*.util.ts` запрещены; импорт снаружи —
  только через `index.ts`.
- Тесты: `__tests__/` рядом с кодом (`*.spec.ts` — юнит, `*.e2e.ts` — e2e).
- DI-зависимости в конструкторах — `private readonly` (CoC §5).
- uuidv7 — только `Bun.randomUUIDv7()` (runtime Bun), своего util нет.
- `common/` — исключение: один `@Global()`-модуль, в подпапках `*.module.ts`
  запрещён; `index.ts`-баррели только в `common/logger/`, `common/validation/`
  и `utils/<name>/`.

## Поток одного запроса

`JwtAuthGuard` → гейт `ProjectAccessService` (`assertProjectAccess` /
`assertProjectAccessById`: org-linked → member, user-space → owner,
stranger → 404 без утечки существования) → jail (`WorkspacePathService` поверх
`REPOS_ROOT`) → транспорт — встроенный `OpencodeHostService` (OpenCode V2
in-process, без внешнего раннера) → маппинг сбоя в `EXTERNAL_*`
(`external-error.ts`) → `ApiErrorFilter` в
`ApiError`-envelope (+`x-correlation-id`) — normal path однострочник
`[http] handled`, без стеков/секретов.

## Журнал решений

- 2026-11-09 — тулы вынесены из `ai/modules/tools/` в sibling `tool-runtime/`
  (контракты + registry + dispatch), `tools/` остался хендлерами и bootstrap —
  раннеру из `sessions/` нужен только dispatch, а хендлерам — только registry,
  без импорта всего набора тулов.
- 2026-11-09 — vault перенесён в `common/` (общий механизм) + top-level
  HTTP-домен `vault/`; владение через полиморфные `consumer_type`
  (user|org) / `consumer_id` без FK; удаление пользователя компенсируется в
  `UsersRepository.deleteById` (удаление org — soft, секреты остаются);
  старый `/api/v1/key` (`opencode/keys.controller.ts`, `common/keys/`) удалён.
