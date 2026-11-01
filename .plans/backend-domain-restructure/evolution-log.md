# Evolution log — backend-domain-restructure

- 2026-11-01 — создан PLAN.md (v1, черновик, код не написан). Границы: Platform / Organization / Project, фазы 0–9, решения §6 открыты.
- 2026-11-01 — Фаза 3 (CoC v2): members/invites вынесены из organizations.service в корневые MembersService/InvitesService + OrgGuardService; pure-хелперы в utils/{uuid-v7,pg-error,organization-member}; публичный API OrganizationsService сохранён делегированием; SQL/таблицы 1:1.
