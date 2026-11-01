# Evolution log — backend-domain-restructure

- 2026-11-01 — создан PLAN.md (v1, черновик, код не написан). Границы: Platform / Organization / Project, фазы 0–9, решения §6 открыты.
- 2026-11-01 — Фаза 3 (CoC v2): members/invites вынесены из organizations.service в корневые MembersService/InvitesService + OrgGuardService; pure-хелперы в utils/{uuid-v7,pg-error,organization-member}; публичный API OrganizationsService сохранён делегированием; SQL/таблицы 1:1.
- 2026-11-01 — Фаза 3 (правка по ревью): organizations.guard.ts — реальный CanActivate (member для GET, maintainer для мутаций, навешан на gated-роуты OrganizationsController; 410-заглушки исключены); MembersModule/InvitesModule в organizations/modules/; randomUuidV7 через Bun.randomUUIDv7.
- 2026-11-01 — uuid-v7 util удалён: генерация через `Bun.randomUUIDv7()` напрямую (Bun runtime), валидация v7 — приватный хелпер в InvitesService; тесты валидатора перенесены в invites spec.
