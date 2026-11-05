# Epoch 4: Refinement — карточки 1-3 (БД, storage, доступ)

## Hypothesis
Карточки 1→2→3 — строгая цепочка: NOT NULL схема разблокирует jail-переписывание, jail разблокирует gate-упрощение.

## Evidence Found
- File: `apps/backend/src/common/db/schema.ts:44-70,190-210` — drizzle-таблица + комментарии про 1:1; `drizzle/`-миграции применяются в e2e через контейнер.
- File: `projects.service.ts create/enrich/removeRepoDirBestEffort` — все три через `resolveUserStrict(ownerKeyOrThrow(...))`.
- File: `project-access.service.ts:160-193 resolveProjectDirectory` — единственная точка разрешения пути для C4/C5.
- File: `project-files.service.ts:92`, `repos.service.ts:34,150`, `workspace-clone.service.ts:94-98`, `workspaces.service.ts:39-92` — полный список user-space потребителей.

## Decisions
- Decision: карточка 1 включает только DDL + close-access без data-migration (дев-данные остаются, но недоступны через gate). Backfill не делаем; org-less строки остаются в БД, но gate их 404ит (уже делает для ownerless — расширить на все org-less).
- Decision: карточка 2 удаляет `resolveUser/*Strict` вызовы из проектов (сам `WorkspacePathService.resolveUser` может остаться как dead-code до отдельной чистки ИЛИ удалиться — вынести в критерии как опцию с дефолтом «оставить метод, убрать вызовы», чтобы diff был минимальным).
- Decision: карточка 3 убирает owner-only ветку и owner-equality fallback в орг-ветке (строго member-only), C4/C5 только member.

## Confirmed Plan Items
1. Карточка 1 «БД: org_id NOT NULL + owner_id audit» — файлы `common/db/schema.ts`, `drizzle/*.sql`, `organizations.service.ts:clearAllForTests`, валидация `bun run db:check-integrity` + e2e up — детали в PLAN.md.
2. Карточка 2 «storage/jail: resolveOrgStrict везде» — файлы `projects.service.ts` (create/enrich/remove), `project-access.service.ts:resolveProjectDirectory`, `project-files.service.ts`, `repos.service.ts`, `workspaces.service.ts`, `workspace-clone.service.ts`, `workspace-path.service.ts` (доки), валидация `grep -rn resolveUser src` пусто для проектов + `grep -rn node:fs` gate.
3. Карточка 3 «доступ: убрать owner-only ветку» — файл `project-access.service.ts:assertProjectAccess*`, C4/C5 только member, ownerless/org-less → 404, валидация спеками `project-access.service.spec`.

## Open Questions
- Удалять ли `resolveUser/*Strict` из `WorkspacePathService` полностью (breaking для возможных внешних вызовов) или оставить — решить в карточке 2 при реализации.
- Нужен ли отдельный `move`-эндпоинт для старых user-директорий — нет (дев-данные не мигрируют, D3).

## Next Epoch Focus
- Epoch 5: карточки 4-6 (контракты, auth auto-org, фронт).
