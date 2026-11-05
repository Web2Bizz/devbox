# Epoch 2: Evidence gathering — что есть сейчас

## Hypothesis
Противоречия user-space vs org-модели сосредоточены в 7 точках: схема БД, storage/jail, access-gate, контракты/DTO/Swagger, auth/register, фронт, тесты/доки.

## Evidence Found
- File: `apps/backend/src/common/db/schema.ts:44-68` — `projects.orgId uuid REFERENCES organizations(id) ON DELETE RESTRICT` **nullable**, `ownerId text` nullable; индексы `projects_org_idx`, `projects_org_status_idx`. Комментарии подтверждают 1:1 через `org_id`, M2M удалена.
- File: `apps/backend/src/common/storage/workspace-path.service.ts:26,60-95,260-369` — `ProjectScope='user'|'org'`, `resolveUser/resolveOrg` + `*Strict` пары, `resolveScoped` строит `users|orgs/<scopeId>/projects/<projectId>/{content,.secrets}`. Jail только через этот сервис; чтения без корня 503 (`throwStorageNotConfigured`), записи 500 (`requireExplicitRoot`).
- File: `apps/backend/src/organizations/modules/projects/modules/project-access/project-access.service.ts:160-193,209-273` — `resolveProjectDirectory` идёт через `resolveUserStrict(ownerKeyOrThrow(ownerId))`; `assertProjectAccess` имеет owner-only ветку для org-less (`orgIds.length===0 → ownerId===userId`) + ownerless → 404 (C5). Орг-ветка: member любой роли проходит, soft-deleted org — 404 для всех, owner-equality fallback после guard.
- File: `apps/backend/src/organizations/modules/projects/projects.service.ts:117-200,326+` — layout-doc `users/<ownerUuid>/projects/<id>`, `ownerKeyOrThrow`, `ownerId` immutable (update reject 400), disk-first create: mint uuid → `resolveUserStrict` → `ensureProjectDirs` → `git init -b main` + empty init commit → INSERT; `enrich`/`removeDirBestEffort` тоже через user-home. Create уже требует `orgId` uuid (400 иначе), POST /projects требует членство (controller:107-110).
- File: `apps/backend/src/organizations/modules/projects/modules/files/project-files.service.ts:92` — `resolveUser` для файлов; `modules/github/github-link.service.ts:9` — комментарий user-home; `modules/repository/modules/repos/repos.service.ts:23,150` — `scope:'users'|'orgs'`; `modules/repository/modules/workspaces/modules/clone/workspace-clone.service.ts:94-98,139-179` — clone через `resolveUser(userId, repoName)`, логи `users/<userId>/projects/<repoName>`; `workspaces.service.ts:39-92` — legacy GET /workspaces через `users/<userId>/projects/<repoName>`.
- File: `packages/contracts/src/project/project.ts:21 + project.schema.ts:13,29-75` — `Project.orgId: string|null` («null for user-space»), `projectScopeSchema=z.enum(['user','org'])`, `createProjectSchema.orgId` уже required uuid, `projectSchema.orgId` nullable, `ownerId` optional/nullable; комментарий «orgId required on create, immutable».
- File: `apps/backend/src/organizations/modules/projects/projects.dto.ts` — DTO `orgId` nullable «null for user-space» (проверить точный текст в реализации).
- File: `apps/backend/src/auth/auth.controller.ts:147-196 + users.service.ts:46-70` — register → `users.createLocal` (trim, lowercase email, hash, 409 duplicate), **без** создания орги; `organizations.service.ts:119-200` — create доступен любому аутентифицированному, disk-first org (500 без корня → INSERT org + maintainer membership в транзакции → `ensureOrgScope` → soft-delete при disk-fail).
- File: `apps/frontend/src/hooks/useProjects.ts + useOrgProjects.ts + components/projects/create-project-dialog/` — две ветки (user-space + org), диалог создаёт проект с nullable orgId; `src/api/types.ts`, `src/lib/types.ts`, `src/lib/mocks/projects.ts` содержат scope.
- File: тесты `workspace-path.spec / project-access.service.spec / repos.service.spec`, e2e `auth/organizations/projects/github/repos/opencode-keys` через testcontainers (`e2e-db.container.ts`), доки `apps/backend/AGENTS.md + ARCHITECTURE.md` описывают user-space как норму.
- Pattern: чтения реестра проектов без корня — `corrupted+storage-unconfigured`, остальные чтения 503, записи 500 (AGENTS.md фолбэк-запрет).

## Decisions
- Decision: подтвердить 7 групп карточек из требований как покрытие всех противоречий.
- Alternatives considered: fewer cards (3-4 крупные) — rejected, теряются зависимости DB→storage→access→contracts→auth→front→tests.
- Rationale: каждая группа имеет чёткий Blocked by порядок.

## Confirmed Plan Items
1. Инвентаризация противоречий завершена — причина: прямые цитаты файлов выше, артефакт epoch-02, валидация grep/read.
2. Порядок карточек: 1 БД → 2 storage/jail → 3 доступ → 4 контракты → 5 auth → 6 фронт → 7 тесты — причина: каждый слой зависит от предыдущего (схема диктует jail, jail диктует gate, gate диктует контракты).

## Open Questions
- Точный текст DTO/Swagger/openapi.yaml расхождений (сверить поле-в-поле в Epoch 4-5).
- Куда положить auto-org по scope-правилам (auth → organizations вызов: разрешён ли downward вызов processes? auth где лежит — `src/auth`, organizations — `src/organizations`; оба верхние слои, вызов должен идти вниз к organizations или через общий сервис — решить в Epoch 3).
- Нейминг персональной орги + идемпотентность (нет natural key на user).

## Next Epoch Focus
- Epoch 3: превратить evidence в решения — судьба owner_id, судьба workspaces/clone, нейминг, scope-размещение, стратегия миграции (NOT NULL + close access без data-migration).
