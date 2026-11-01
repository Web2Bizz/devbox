# Evolution log — backend-domain-restructure

- 2026-11-01 — создан PLAN.md (v1, черновик, код не написан). Границы: Platform / Organization / Project, фазы 0–9, решения §6 открыты.
- 2026-11-01 — Фаза 3 (CoC v2): members/invites вынесены из organizations.service в корневые MembersService/InvitesService + OrgGuardService; pure-хелперы в utils/{uuid-v7,pg-error,organization-member}; публичный API OrganizationsService сохранён делегированием; SQL/таблицы 1:1.
- 2026-11-01 — Фаза 3 (правка по ревью): organizations.guard.ts — реальный CanActivate (member для GET, maintainer для мутаций, навешан на gated-роуты OrganizationsController; 410-заглушки исключены); MembersModule/InvitesModule в organizations/modules/; randomUuidV7 через Bun.randomUUIDv7.
- 2026-11-01 — uuid-v7 util удалён: генерация через `Bun.randomUUIDv7()` напрямую (Bun runtime), валидация v7 — приватный хелпер в InvitesService; тесты валидатора перенесены в invites spec.
- 2026-11-01 — Фаза 4 (CoC v2): C4-гейт вынесен в organizations/modules/projects/modules/project-access (ProjectAccessModule); projects/chats/sessions/files больше не импортируют OrganizationsModule; webhook-util -> github/utils/webhook; optional DI deps readonly.
- 2026-11-01 — Фаза 5A (CoC v2): ai -> processes/modules/ai, workers -> processes/modules/workers, добавлен ProcessesModule (AppModule монтирует его); маршруты/DTO не менялись.
- 2026-11-01 — Фаза 5B (CoC v2): repos/ + workspaces/ -> organizations/modules/projects/modules/repository (modules/repos, modules/workspaces, utils/repos-git, utils/submodules); dead duplicate jobs/ удалён; единый jail: fs-примитивы в common/storage, прямой node:fs убран из projects/files/organizations.
- 2026-11-01 — Фазы 6–9: решения §6.8/6.9 зафиксированы; ARCHITECTURE/AGENTS обновлены; пути SDK-плана актуализированы; контракты не менялись (diff пустой); финальные гейты: lint, build, test (238 ok), полный test:e2e, db:check-integrity — PASS.
