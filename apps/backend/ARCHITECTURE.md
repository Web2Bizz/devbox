# ARCHITECTURE.md

## Scope-слои (после `.plans/backend-domain-restructure`)

| Scope | Что владеет | От кого зависит |
|---|---|---|
| **Common** | `common/*` (logger, env-контракт, validation, external/retry, http-фильтры+interceptors, sse, db, storage-jail, crypto-KEK, keys-store), `health/`, `users/` (профили), `auth/` (JWT guard/token/password) | только NestJS + pg/drizzle + zod |
| **Organization** | `organizations/` (CRUD, `members/`, `invites/`, `registries/`), `organizations/projects/` (проект живёт ТОЛЬКО тут: `access/`, `files/`, `github-link/`, `chats/`, `sessions/`, `repository/`) | только Common |
| **Processes** | `processes/ai/` (`agents/`, `sessions/` — доменные `/api/sessions*`, `opencode/` — транспорт+зеркало+keys HTTP), `processes/workers/` | Common + Organization |

Стрелка зависимости — только вниз: `Processes → Organization → Common`.
Запрещено: `common/** → domains`, `organizations/** → processes/**` (единственное
исключение — `organizations/org-projects.controller.ts`, помечен `SCOPE-EXCEPTION`:
тонкая проекция, только делегирование). `app/` — композиционный корень
(`app.module.ts`, `app.setup.ts`), не растворяется по доменам.

## Дерево `src/`

```
src/
├─ main.ts — бутстрап (dotenv-expand, configureApp/setupSwagger, validateEnvWithWarnings)
├─ contracts.ts — deprecated-реэкспорт @rush-code/contracts (удаляется в SDK-миграции)
├─ app/ — app.module.ts (DI-граф: Common → Organization → Processes), app.setup.ts
├─ common/ — SCOPE: Common
│  ├─ logger/ env/ validation/ external/ sse/
│  ├─ http/ — api-error.filter, correlation/noindex interceptors, api/ (version, dto)
│  ├─ db/ — schema.ts, db.module/service, schema-integrity
│  ├─ storage/ — storage-unavailable.ts (503-гейт), workspace-path.service.ts (jail + fs-primitives)
│  ├─ crypto/ — CryptoService (AES-256-GCM KEK) + CryptoModule
│  ├─ keys/ — OpencodeKeysService store/module/reencrypt (+ schema)
│  ├─ health/ — HealthRegistry (домены self-register probes на OnModuleInit)
│  └─ common.module.ts — @Global: AppLogger, ExternalClient, HealthRegistry, DbModule
├─ auth/ — JWT guard/token/password/identity (sibling users/, SCOPE: Common)
├─ users/ — профили (UsersModule @Global)
├─ health/ — GET /health + /api/v1/health (импортирует только DbModule + HealthRegistry)
├─ organizations/ — SCOPE: Organization
│  ├─ organizations.{module,service,controller}.ts
│  ├─ organizations.types.ts — типы/codecs/uuidv7
│  ├─ org-guard.service.ts — membership lookups + role gates
│  ├─ members/ — MembersService (list/add/remove/changeRole)
│  ├─ invites/ — InvitesService (uuidv7 single-use, no TTL)
│  ├─ org-projects.controller.ts — SCOPE-EXCEPTION: projection
│  ├─ registries/ — docker/ + npm/ (observe-only)
│  ├─ projects/
│  │  ├─ projects.{module,service,controller}.ts
│  │  ├─ access/ — ProjectAccessService (C4 gate: assertProjectAccessById)
│  │  ├─ files/ chats/ sessions/ (persistence) github-link/
│  │  └─ repository/ — git на диске: repos catalog, workspaces tree, clone/, jobs/, repos-git.util
│  └─ __tests__/ — spec-и, которые обязаны видеть домены (storage-unavailable.spec)
├─ processes/ — SCOPE: Processes
│  ├─ processes.module.ts — агрегатор ai (+workers через AiModule)
│  ├─ ai/ — ai.module.ts
│  │  ├─ agents/ — AgentsController
│  │  ├─ sessions/ — доменные /api/sessions* (VERSION_NEUTRAL, 9 роутов)
│  │  └─ opencode/ — OpencodeService/SdkClient, billing/auth, deprecated /api/opencode/* (18),
│  │     keys.controller.ts (/api/v1/key, /api/v1/usage), keys.e2e.ts (эталон скана секретов)
│  └─ workers/ — scaffold (без контроллера)
```

## Поток одного запроса

`JwtAuthGuard` (`auth/`) → C4-гейт
`ProjectAccessService.assertProjectAccessById` (`organizations/projects/access/`, 404 без утечки)
→ jail `WorkspacePathService` поверх `REPOS_ROOT` (`common/storage/`) → upstream к runner:
sdk (`OpencodeSdkClient`) для полей, которые генератор НЕ режет, иначе сырой
`fetchWithRetry` + `serveBasicAuthHeader` → маппинг сбоя в `EXTERNAL_*`
(`common/external/external-error.ts`) → `ApiErrorFilter` (`common/http/`) в `ApiError`-envelope
(+`x-correlation-id`) — normal path однострочник `[http] handled`, без стеков/секретов.

## Инварианты

- `REPOS_ROOT` — единственный корень чтения И записи; без него storage-чтения 503/`corrupted`,
  создание проектов 500 (без `<cwd>/repos` fallback).
- Весь дисковый I/O — через `common/storage/` (jail + `ensureDir/removeDir/statPath/readDir`)
  или `organizations/projects/repository/`; исключение — `resolveGithubPrivateKey` в `common/env`.
- Все проектные роуты идут через `organizations/projects/access` (единый C4-гейт).
- `processes/*` не хранит строки без FK на проекты и не стартует сам: вход — HTTP с
  `projectId` (gate) или событие `workers/`.
- Секреты и их поведение без значения — карта в `.plans/backend-domain-restructure/PLAN.md` §4;
  значения/env-контракт не менялись.

## Проверки

`bun run lint` (tsc --noEmit + biome) · `bun run build` · `bun run test` (spec из dist) ·
`bun run test:e2e` (полный) · точечные `:auth` `:projects` `:github` `:repos` `:opencode-keys` ·
`bun run db:check-integrity`.
