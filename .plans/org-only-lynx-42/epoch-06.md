# Epoch 6: Validation — карточка 7 + Trello-готовность

## Hypothesis
Карточка 7 закрывает инварианты: unit+e2e доказывают отсутствие user-space путей, доки больше не описывают user-space как норму, scope-правила не нарушены.

## Evidence Found
- File: `apps/backend/src/**/__tests__/*.spec.ts|*.e2e.ts` — workspace-path.spec, project-access.service.spec, repos.service.spec; e2e раннер `scripts/e2e.ts` (бюджеты `E2E_SUITE_TIMEOUT_MS`), suites auth/organizations/projects/github/repos/opencode-keys через testcontainers; `keys.e2e.ts` — эталон secret-скана.
- File: `apps/backend/AGENTS.md|ARCHITECTURE.md|CODE_OF_CONDUCT.md`, `docs/manual-migration-orgs-layout.md`, `contracts/openapi.yaml` — доки к правке.
- Pattern: проверки `bun run lint` (tsc+biome), `bun run build`, `bun run test`, `bun run test:e2e:<suite>`.

## Decisions
- Decision: карточка 7 включает: обновить/удалить user-space кейсы в спеках, добавить e2e «register→personal org→create project→member-only access→stranger 404→org-less 404», прогнать secret-скан, обновить AGENTS.md/ARCHITECTURE.md/openapi.yaml, проверить scope-gate (`grep node:fs`, `common/*.module.ts` единственный, вложенность `<parent>/modules/<sub>/`).
- Decision: формат Trello-карточек — Заголовок / Что сделать / Критерии / Файлы / Blocked by — готов к `task-manager` заведению отдельным вызовом (не в этом плане).

## Confirmed Plan Items
1. Карточка 7 файлы: `**/__tests__/*spec*|*e2e*`, `ARCHITECTURE.md|AGENTS.md|docs/*`, валидация `bun run lint && bun run build && bun run test && bun run test:e2e`.
2. PLAN.md синтезирует эпохи 1-6 в 7 карточек с зависимостями 1→2→3→4→5→6→7 (4 может идти параллельно с 5 после 3; 6 после 4+5).
3. evolution-log.md фиксирует историю решений D1-D4 + A/B/C/D.

## Open Questions
- Остаток: Q1/Q2/Q3 из Epoch 3 — вынести в PLAN.md как явный раздел (не код).
- Заведение Trello-карточек — вне скоупа этого вызова (следующий вызов с task-manager).

## Next Epoch Focus
- Финализация: написать PLAN.md + evolution-log.md, доложить пользователю.
