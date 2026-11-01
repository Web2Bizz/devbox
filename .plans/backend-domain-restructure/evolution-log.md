# Evolution log — backend-domain-restructure

- 2026-11-01 — создан PLAN.md (v1, черновик, код не написан). Границы: Platform / Organization / Project, фазы 0–9, решения §6 открыты.
- 2026-11-01 — PLAN.md v2: platform→common, crypto/keys→common, projects внутрь organizations, ai+workers→processes.
- 2026-11-01 — Фаза 0: инвентаризация. База lint+build зелёная. Найдены 4 нарушения стрелок (health→ai/registries, keys-controller→billing, sessions→orgs, storage-spec→домены) и 4 сломанных e2e-скрипта. Dirty tree 256 записей, `src/{ai,app}`, `common/{db,env,logger,validation}`, `organizations/modules`, `workspaces/modules` untracked.
- 2026-11-01 — Решения §6 закрыты пользователем (все дефолты (a)); дополнительно одобрен минимальный inversion-рефакторинг для health и keys. Зафиксировано в PLAN.md §6.8.
- 2026-11-01 — Checkpoint-коммит `4041c77` (baseline до фаз), секреты не попали (`.env`, `keys/` gitignored).
- 2026-11-01 — Фаза 1A `a4c0885`: crypto/keys→common, storage-unavailable + workspace-path→common/storage (path.module.ts удалён), common/api + filter/interceptors→common/http, sse-relay→common/sse, e2e-скрипты выровнены по дереву. lint+build зелёные, auth 3/3.
- 2026-11-01 — Фаза 1B `278df2d`: keys HTTP-поверхность (controller/dto/e2e) → ai/modules/opencode; health инвертирован через `common/health/health-registry.ts` (домены self-register в OnModuleInit); `.gitignore` `/keys/`; crypto empty-plaintext guard `<`. Гейты: lint+build, auth 3/3, opencode-keys (crypto 11 + hardening 27 + keys 6), unit-все, versioning 22/22, grep-границы пустые.
