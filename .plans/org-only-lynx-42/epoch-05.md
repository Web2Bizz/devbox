# Epoch 5: Refinement — карточки 4-6 (контракты, auth, фронт)

## Hypothesis
После упрощения gate контракты и фронт — механическое удаление user-space веток; auth auto-org — единственная новая фича (транзакция).

## Evidence Found
- File: `packages/contracts/src/project/project.schema.ts` + `project.ts` + `contracts/openapi.yaml components/schemas: Project, CreateProject` — зеркало поле-в-поле (AGENTS.md contracts: расхождение = баг пакета).
- File: `projects.dto.ts` (backend) — ZodValidationPipe на входе, Swagger `@ApiProperty` на выходе.
- File: `auth.controller.ts:147-196` — register flow без орги; `users.service.ts:createLocal` — точка расширения (возвращает StoredUser).
- File: `organizations.service.ts:119-200` — готовый паттерн транзакции org+maintainer + `ensureOrgScope` + soft-delete rollback при disk-fail — переиспользовать для personal.
- File: `apps/frontend/src/hooks/useProjects.ts|useOrgProjects.ts`, `components/projects/create-project-dialog/`, `api/types.ts`, `lib/mocks/projects.ts` — user-ветки к удалению; персональная орга — default selection.

## Decisions
- Decision: карточка 4 — `orgId: string` (non-nullable) в `Project`, удалить `projectScopeSchema` + `ProjectScope` + scope-поля из repos DTO, `CreateProject.orgId` остаётся required, `UpdateProject` запрещает смену orgId (400, как ownerId раньше); `contracts/openapi.yaml` обновляется синхронно (источник правды).
- Decision: карточка 5 — auto-org в транзакции register: `users.insertLocal → organizations.insert + members.insert(maintainer)` в одной DB-транзакции (или компенсация при раздельных транзакциях — выбрать при реализации, дефолт одна транзакция через DbService.client.transaction); disk `ensureOrgScope` после коммита с soft-delete rollback по образцу `organizations.create`; нейминг/идемпотентность по Epoch 3-C; scope-размещение по Epoch 3-D.
- Decision: карточка 6 — фронт: удалить user-space ветки, `create-project-dialog` всегда требует `orgId` (персональная орга по умолчанию из `useOrganizations`), `useProjects` → тонкая обёртка над `useOrgProjects` или удалить; моки/типы обновить.

## Confirmed Plan Items
1. Карточка 4 файлы: `packages/contracts/src/project/*`, `contracts/openapi.yaml`, `apps/backend/.../projects.dto.ts`, Swagger-декораторы, `project-schemas` тесты.
2. Карточка 5 файлы: `apps/backend/src/auth/*`, `users.service.ts|users.repository.ts`, `organizations.service.ts` (новый `createPersonal` или переиспользование `create`), `organizations/utils/*` нейминг-хелпер, e2e `auth.e2e`.
3. Карточка 6 файлы: `apps/frontend/src/hooks/useProjects.ts|useOrgProjects.ts|query-keys.ts`, `components/projects/create-project-dialog/*`, `api/types.ts|lib/types.ts|lib/mocks/*`, i18n строки.

## Open Questions
- Разрешить ли смену orgId проектом (move между оргами) — дефолт нет (immutable как ownerId раньше), отдельный move-эндпоинт вне скоупа.
- Точный нейминг персональной орги (Q3) — финализировать в карточке 5.

## Next Epoch Focus
- Epoch 6: карточка 7 (тесты+e2e+доки) + финализация PLAN.md с Trello-карточками и Blocked by.
