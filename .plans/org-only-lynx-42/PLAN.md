# PLAN: Backend → org-only модель проектов

> Директория плана: `.plans/org-only-lynx-42/` (эпохи 01-06 + этот файл + evolution-log.md).
> Статус: **только план**, кода нет. Реализация — отдельным вызовом. Trello-заведение — следующим вызовом через task-manager.

## Целевое состояние
- У пользователя нет своих проектов; проект всегда принадлежит ровно одной организации (`projects.org_id NOT NULL`).
- Диск-layout только `orgs/<orgId>/projects/<projectId>/content` (+ `.secrets` резервы); зависимость пути от создателя убрана (`resolveOrgStrict` везде).
- Существующие `apps/backend/repos/users/*` — дев-данные, не мигрируются; доступ к org-less строкам закрыт (404 без утечки, как strangers).
- Register создаёт персональную организацию + membership owner/maintainer в транзакции; API проектов по-прежнему требует `orgId`.
- Контракты/DTO/Swagger/openapi.yaml без user-space (`orgId: string`, нет `ProjectScope 'user'|'org'`); фронт без user-веток, диалог создания только с `orgId` (персональная орга по умолчанию).

## Non-negotiable решения пользователя (D1-D4, не менять)
- D1. Личная организация — авто при регистрации (org + membership owner/maintainer в транзакции). Проект создаётся в ней или в любой другой, где пользователь участник. API требует orgId.
- D2. Disk-layout `orgs/<orgId>/projects/<projectId>/content`; переписать `resolveProjectDirectory` на `resolveOrgStrict`.
- D3. `apps/backend/repos/users/*` — дев-данные, не мигрировать; доступ к org-less строкам закрыть.
- D4. Сейчас только план с декомпозицией на Trello-карточки; реализация потом.

## Scope-правила (обязательны для всех карточек)
- Слои: `processes/ → organizations/ → common/`, стрелка только вниз. `common/` не знает доменов; `organizations/` не импортирует `processes/` (в т.ч. `ai`).
- `common/` — ОДИН `@Global()` модуль (`common.module.ts`); в подпапках `*.module.ts` запрещены (CoC §3). Новый кросс-доменный код — в `common/`.
- Вложенные модули — только `<parent>/modules/<sub>/` (CoC §2), наружу торчит родитель. Утилиты — `utils/<name>/` со своим `index.ts` + `__tests__/`.
- Storage: `REPOS_ROOT` — единственный корень; fs только через `WorkspacePathService` или `repository/**`; `cwd`/`__dirname` как корень запрещены. Чтения без корня 503, записи 500; `GET /projects`, `GET /projects/:id` без корня — `corrupted + storage-unconfigured`.
- DI-конструкторы — `private readonly`; логи только через `AppLogger`, без стеков/секретов в normal path; uuidv7 — `Bun.randomUUIDv7()`.
- Проверки каждой карточки: `bun run lint` (tsc + biome) + `bun run build`; где указано — `bun run test` / `test:e2e:*`.

---

## Карточка 1 — БД + миграция: `org_id NOT NULL`, судьба `owner_id`

**Что сделать**
1. В `apps/backend/src/common/db/schema.ts` сделать `projects.orgId` NOT NULL (убрать nullable), обновить комментарии (1:1, org-only). `ownerId` ОСТАВИТЬ как audit `createdBy` (рекомендовано): добавить комментарий «audit only, never used for path/authz», оставить nullable text (legacy NULL), новые ряды всегда пишут creator id; `update()` продолжает reject смену 400 (immutable audit).
2. Написать `drizzle/`-миграцию: `ALTER TABLE projects ALTER COLUMN org_id SET NOT NULL` (+ коммент). Без data-migration дев-данных (D3): если в dev-БД есть org-less строки — миграция их не чинит; доступ к ним закрывается карточкой 3 (404). Для чистой накатки e2e/testcontainers проблем нет.
3. Обновить `clearAllForTests` порядок (уже org→projects) если потребуется под NOT NULL.
4. Альтернатива (не выбрана, зафиксировать решение при реализации): DROP `owner_id` полностью или rename в `created_by` — отдельной миграцией позже, вне скоупа.

**Критерии**
- `bun run db:check-integrity` зелёный; e2e поднимаются на чистой БД (testcontainers) без ошибок NOT NULL.
- `INSERT без org_id` падает на уровне БД (NOT NULL violation → 500/dbUnavailable, не тихий успех).
- `grep -rn "null for user-space" apps/backend/src packages/contracts/src` не находит БД-комментариев про user-space.

**Файлы**
- `apps/backend/src/common/db/schema.ts` (таблица `projects`)
- `apps/backend/drizzle/*.sql` (новая миграция)
- `apps/backend/src/organizations/organizations.service.ts` (`clearAllForTests`, каскад soft-delete — без изменений логики, только проверка)

**Blocked by**: — (корень цепочки).

---

## Карточка 2 — storage/jail: `resolveOrgStrict` везде, судьба legacy workspaces/clone

**Что сделать**
1. `projects.service.ts`: create / enrich / removeRepoDirBestEffort / getOrThrow — заменить `resolveUserStrict(ownerKeyOrThrow(ownerId))` на `resolveOrgStrict(orgId)`; удалить `ownerKeyOrThrow`/`SYSTEM_OWNER_UUID`-коалесцинг из этого сервиса; обновить layout-doc (только `orgs/<orgUuid>/projects/<id>/{content,.secrets} + orgs/<orgUuid>/.secrets`).
2. `project-access.service.ts:resolveProjectDirectory` — переписать на `resolveOrgStrict` (D2); обновить doc-комментарии C4/C5.
3. `project-files.service.ts:92`, `github-link.service.ts`, `repos.service.ts` (scope `'users'|'orgs'` → только `'orgs'`), `workspaces.service.ts:39-92`, `workspace-clone.service.ts:94-179` — перевести на `resolveOrg`/`resolveOrgStrict`; логи `users/...` → `orgs/...`.
4. Судьба legacy (решить при реализации, дефолт — fail-closed по прецеденту link/unlink 410): `GET /workspaces` user-space дерево и clone через `users/<userId>/...` либо удалить (410 Gone), либо переписать на org-scoped (`orgs/<orgId>/projects/<id>`). Результат зафиксировать в Swagger.
5. `WorkspacePathService`: обновить class-doc (убрать `users/...` из canonical layout); сами методы `resolveUser/*Strict` оставить как dead-code ИЛИ удалить — решить в реализации (дефолт: оставить метод, убрать все вызовы из проектов, чтобы diff минимален).

**Критерии**
- `grep -rn "resolveUser" apps/backend/src --include="*.ts" | grep -v spec | grep -v workspace-path.service` — пусто для проектных путей (допустим только сам сервис + тесты).
- `grep -rn "users/<" apps/backend/src --include="*.ts" | grep -v spec` — пусто (кроме исторических комментов с пометкой removed).
- `grep -rn "node:fs" apps/backend/src --include="*.ts"` — только `common/storage/*` + `repository/**` (jail-gate держится).
- Disk-first инвариант сохранён: create без `REPOS_ROOT` → 500 до mkdir/INSERT; чтения без корня → 503 (кроме реестра → `corrupted/storage-unconfigured`).

**Файлы**
- `apps/backend/src/organizations/modules/projects/projects.service.ts`
- `apps/backend/src/organizations/modules/projects/modules/project-access/project-access.service.ts`
- `apps/backend/src/organizations/modules/projects/modules/files/project-files.service.ts`
- `apps/backend/src/organizations/modules/projects/modules/github/github-link.service.ts`
- `apps/backend/src/organizations/modules/projects/modules/repository/modules/repos/repos.service.ts|repos.dto.ts|repos.controller.ts`
- `apps/backend/src/organizations/modules/projects/modules/repository/modules/workspaces/workspaces.service.ts|workspaces.controller.ts|modules/clone/workspace-clone.service.ts`
- `apps/backend/src/common/storage/workspace-path.service.ts` (доки + опционально удаление user-методов)

**Blocked by**: Карточка 1 (схема диктует jail-ключи).

---

## Карточка 3 — доступ: убрать owner-only ветку, C4/C5 только member

**Что сделать**
1. В `project-access.service.ts:assertProjectAccess/assertProjectAccessById/orgIdsForProject/getRole` убрать user-space ветку (`orgIds.length===0 → owner===user`) и owner-equality fallback в орг-ветке. Новое правило:
   - `org_id` set → доступ только при `getRole(orgId,userId)` non-null (любая роль); soft-deleted org → 404 для всех;
   - `org_id` NULL (legacy/dev) → всегда 404 (расширить существующий C5 ownerless-deny на все org-less, D3);
   - non-uuid requester (legacy mock) → 404 (membership lookup невозможен);
   - DB outage → 503 через `dbUnavailable`, не 404.
2. Обновить godoc/comment блока C4/C5 (убрать «belongs to exactly one org or to no org (user-space)»).
3. Проверить callers: sessions/chats/project-files, top-level `:id` routes, opencode/proxy gate — все через `assertProjectAccessById`, отдельных правок не требуют, но прогнать спеки.

**Критерии**
- `project-access.service.spec.ts` обновлён: кейсы «owner-only user-space проходит» удалены/инвертированы (теперь 404); «stranger → 404», «non-member org → 404», «ownerless/org-less → 404», «member любой роли → pass», «soft-deleted org → 404 даже для owner», «DB down → 503».
- `grep -rn "owner-only\|user-space" apps/backend/src/organizations/modules/projects/modules/project-access/` — только исторические пометки removed.
- Ручной e2e-сценарий (карточка 7): stranger не энумерирует проект (404 без утечки существования).

**Файлы**
- `apps/backend/src/organizations/modules/projects/modules/project-access/project-access.service.ts`
- `apps/backend/src/organizations/modules/projects/modules/project-access/__tests__/project-access.service.spec.ts`
- Комментарии callers (без логики): `projects.service.ts`, `project-files.service.ts`, sessions/chats gates

**Blocked by**: Карточка 2 (gate опирается на org-разрешение пути).

---

## Карточка 4 — контракты + DTO + Swagger + openapi.yaml

**Что сделать**
1. `packages/contracts/src/project/project.ts`: `Project.orgId: string` (убрать `| null`, обновить комментарий); удалить `ProjectScope='user'|'org'` (или оставить как deprecated только если фронт ещё ссылается — дефолт удалить).
2. `packages/contracts/src/project/project.schema.ts`: удалить `projectScopeSchema`; `projectSchema.orgId = z.uuid()` (non-nullable); `createProjectSchema.orgId` остаётся required; `updateProjectSchema` — запретить смену `orgId` (omit или refine 400, по аналогии с ownerId immutable); `ownerId` в create — оставить optional audit (кто создал), в response — nullable audit.
3. Backend DTO: `projects.dto.ts` — `orgId` required (убрать «null for user-space»), Swagger `@ApiProperty(required:true)`; `repos.dto.ts` scope → только `'orgs'`; `workspaces.dto.ts` — по исходу карточки 2 (410 или org-scoped).
4. `contracts/openapi.yaml components/schemas: Project, CreateProject, UpdateProject (+ RepoScope если есть)` — привести поле-в-поле (YAML — источник правды).
5. Прогнать `packages/contracts` тесты схем (`project-schemas`).

**Критерии**
- `Project.orgId` non-nullable в `project.ts` + `project.schema.ts` + `openapi.yaml` + backend DTO — все четыре слоя совпадают.
- `grep -rn "projectScopeSchema\|ProjectScope\|'user'|'org'\|\"user\".*\"org\"" packages/contracts/src apps/backend/src apps/frontend/src --include="*.ts" --include="*.tsx"` — пусто (кроме evolution-доков).
- `bun run build` в `packages/contracts` + backend typecheck зелёные; Swagger UI показывает `orgId` required, без scope.

**Файлы**
- `packages/contracts/src/project/project.ts|project.schema.ts|index.ts`
- `contracts/openapi.yaml`
- `apps/backend/src/organizations/modules/projects/projects.dto.ts`
- `apps/backend/src/organizations/modules/projects/modules/repository/modules/repos/repos.dto.ts`
- `apps/backend/src/organizations/modules/projects/modules/repository/modules/workspaces/workspaces.dto.ts`

**Blocked by**: Карточка 3 (контракт фиксирует gate-семантику; технически может идти параллельно с 5 после 3).

---

## Карточка 5 — auth/register: авто-создание персональной организации

**Что сделать** (единственная новая фича; размещение по scope-правилам — Epoch 3-D)
1. Новый метод в `organizations/` (напр. `OrganizationsService.createPersonal(userId, {firstName,lastName,email})` в `organizations/modules/personal/` или прямо в сервисе — вложенность `<parent>/modules/<sub>/`): транзакция `org INSERT + member INSERT(owner/maintainer)` (паттерн `organizations.service.ts:152-169`), затем `ensureOrgScope(orgId)` с soft-delete rollback при disk-fail (паттерн `:174-200`).
2. Нейминг (дефолт, финализировать при реализации): `name="<firstName>’s workspace"` (fallback `"Personal workspace"`), `isPrivate=true`, `description=null`. Чистая функция нейминга в `organizations/utils/personal-name/ + __tests__/`.
3. Вызов из register-flow (`auth.controller.ts:register → users.createLocal` + новый шаг): одна DB-транзакция `users + orgs + members` (дефолт; альтернатива — раздельные транзакции с компенсацией DELETE user при org-fail — выбрать при реализации). Повторный register с тем же email → 409 до создания орги (идемпотентность, без сиротских орг). Никогда не логировать email/tokens.
4. Роль персональной орги: creator = `maintainer` (прецедент `organizations.create` owner-as-maintainer; решение D1 допускает owner/maintainer — зафиксировать `maintainer` как канон single-maintainer инварианта).
5. `POST /organizations` остаётся доступным любому аутентифицированному (без изменений) — дополнительные орги создаются как раньше.

**Критерии**
- e2e `auth.e2e`: register → `GET /organizations` содержит ровно 1 персональную оргу (`isPrivate=true`); `POST /projects {orgId: personal}` → 201; stranger (второй юзер) → 404 на проект; `GET /projects` второго юзера пуст.
- Ретрай register с тем же email → 409, сиротских орг в БД нет (проверка `SELECT count` в e2e).
- Без `REPOS_ROOT` register падает предсказуемо (500 storage, не тихий успех без `orgs/<id>` дома) — по образцу org-create gate; либо явное решение «user создан, орга отложена» — зафиксировать при реализации, дефолт fail-fast 500.
- Scope-gate: нет новых `*.module.ts` в `common/`; вызов направлен `auth → organizations → common`, обратных импортов нет (`grep` проверка).

**Файлы**
- `apps/backend/src/auth/auth.controller.ts|auth.dto.ts|auth.module.ts`
- `apps/backend/src/users/users.service.ts|users.repository.ts`
- `apps/backend/src/organizations/organizations.service.ts` (+ новый `modules/personal/*` или метод `createPersonal`)
- `apps/backend/src/organizations/utils/*` (нейминг-хелпер) — без нового модуля в `common/`
- `apps/backend/src/common/storage/workspace-path.service.ts` (`ensureOrgScope` — переиспользование, без изменений)
- `apps/backend/src/auth/__tests__/auth.e2e.ts` (или соответствующий e2e-файл)

**Blocked by**: Карточки 1-3 (транзакция опирается на NOT NULL схему + member-gate); может идти параллельно с карточкой 4.

---

## Карточка 6 — фронт: убрать user-space ветки, диалог только с orgId

**Что сделать**
1. `useProjects.ts` — удалить user-space ветку (или сделать тонкой обёрткой над `useOrgProjects`); `useOrgProjects.ts` — канон; `query-keys.ts` — убрать user-scope ключи; `orgScopeMapping.test.ts` + `useOrganizations.test.tsx` — обновить.
2. `components/projects/create-project-dialog/` — всегда требует `orgId`; персональная орга выбрана по умолчанию (первая из `useOrganizations`, `isPrivate` первой); без организаций — пустое состояние с CTA «создать организацию» (не тихий фолбэк).
3. `api/types.ts`, `lib/types.ts`, `lib/mocks/projects.ts` — `orgId: string` (non-null), удалить `ProjectScope`/scope-маппинги; i18n строки про user-space удалить.
4. Проверить места, где фронт дергал legacy `GET /workspaces` / clone с user-ключами — перевести на org или удалить по исходу карточки 2.

**Критерии**
- `grep -rn "ProjectScope\|projectScope\|user.*space\|users.*projects" apps/frontend/src --include="*.ts" --include="*.tsx"` — пусто (кроме моков истории с пометкой).
- UI-сценарий: новый юзер после register видит персональную оргу; создание проекта без выбора орги уходит в неё; stranger не видит чужой проект.
- `bun run lint && bun run build` фронта зелёные; обновлённые hook-тесты зелёные.

**Файлы**
- `apps/frontend/src/hooks/useProjects.ts|useOrgProjects.ts|query-keys.ts|useOrganizations.ts`
- `apps/frontend/src/hooks/__tests__/query-keys.test.ts|orgScopeMapping.test.ts|useOrganizations.test.tsx`
- `apps/frontend/src/components/projects/create-project-dialog/*`
- `apps/frontend/src/api/types.ts|src/lib/types.ts|src/lib/mocks/projects.ts`
- `apps/frontend/src/i18n/*` (строки)

**Blocked by**: Карточки 4 + 5 (контракт non-null orgId + наличие personal org).

---

## Карточка 7 — тесты + e2e + доки

**Что сделать**
1. Unit: обновить `workspace-path.spec` (только org-кейсы + jail 400/403/503/500 матрица), `project-access.service.spec` (см. критерии карточки 3), `repos.service.spec` (только `orgs/` scope), добавить спек нейминга personal-org.
2. e2e (testcontainers, раннер `scripts/e2e.ts`): сквозной `register → personal org → create project {orgId} → member read/write → stranger 404 → org-less row 404 → soft-deleted org 404`; outage-кейсы (`E2E_DB_MODE=unreachable` → 503, пустой `REPOS_ROOT` → 500/503 по матрице); прогнать secret-скан (эталон `keys.e2e.ts`).
3. Доки: `apps/backend/AGENTS.md`, `ARCHITECTURE.md`, `CODE_OF_CONDUCT.md` (если упоминает user-space), `docs/manual-migration-orgs-layout.md` (пометить frozen/pre-org-only, добавить «dev-данные не мигрируют»), Swagger/openapi.yaml описания.
4. Scope-валидация: `grep -rn "node:fs" src` (только storage/repository), единственный `common.module.ts`, вложенность `<parent>/modules/<sub>/`, `bun run lint && bun run build && bun run test && bun run test:e2e`.

**Критерии**
- Все сьюты `auth|organizations|projects|github|repos|opencode-keys` зелёные через `bun run test:e2e` (или точечные `test:e2e:<suite>`).
- Ни один тест не создаёт проект без `orgId`; ни один тест не обращается к `users/<id>/projects`.
- Доки не описывают user-space как норму (`grep -ri "user-space\|user space" apps/backend/*.md` — только исторические пометки).

**Файлы**
- `apps/backend/src/**/__tests__/*.spec.ts|*.e2e.ts`
- `apps/backend/AGENTS.md|ARCHITECTURE.md|CODE_OF_CONDUCT.md`
- `docs/manual-migration-orgs-layout.md`, `contracts/openapi.yaml` (описания)
- `apps/backend/scripts/e2e.ts` (без изменений логики, только фильтры при прогоне)

**Blocked by**: Карточки 1-6 (финальная валидация).

---

## Порядок реализации (зависимости)
```
1 (БД)
└→ 2 (storage/jail)
   └→ 3 (доступ)
      ├→ 4 (контракты)
      └→ 5 (auth auto-org)
          └→ 6 (фронт, после 4+5)
             └→ 7 (тесты/доки)
```
- 4 и 5 могут идти параллельно после 3 (разные слои, общий предок — gate).
- 6 строго после 4+5 (фронту нужны и контракт, и personal org).
- Заведение в Trello — следующим вызовом (task-manager), не в этом плане.

## Открытые вопросы (не код, решить при реализации карточек)
- **Q1 owner_id — оставить или убрать?** Рекомендация плана: ОСТАВИТЬ как `createdBy` audit (nullable text, immutable, не участвует в path/authz); DROP/rename — отдельной задачей позже. Финальное слово — карточка 1.
- **Q2 судьба `GET /workspaces` и clone через `users/<userId>/projects/<repoName>`?** Рекомендация: 410 Gone для user-space путей (прецедент link/unlink) либо переписывание на org-scoped, если фича жива. Финальное слово — карточка 2.
- **Q3 нейминг персональной организации?** Рекомендация: `"<firstName>’s workspace"` / fallback `"Personal workspace"`, `isPrivate=true`. Альтернативы: email-prefix, `personal-<suffix>`. Идемпотентность ретрая register — одна транзакция + 409 на дубль email. Финальное слово — карточка 5.

## Риски
- NOT NULL миграция упадёт на dev-БД с org-less строками → митигация: сначала close-access (gate 404), миграцию катить на чистые окружения/e2e; dev-данные по D3 не чиним.
- Раздельные транзакции register (user vs org) дадут сирот → митигация: одна транзакция или компенсация, e2e-проверка count.
- Фронт-кэши со старым nullable `orgId` → митигация: контракт major, инвалидация query-keys (карточка 6).
- Потеря аудита при DROP owner_id → митигация: рекомендация Q1 (оставить audit).
