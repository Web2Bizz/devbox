# Epoch 1: Coarse hypothesis — org-only модель

## Hypothesis
Backend переходит на org-only: у пользователя нет своих проектов, проект всегда принадлежит ровно одной организации (`projects.org_id NOT NULL`). Личная организация создаётся автоматически при регистрации, проект создаётся только в организации где пользователь — member. Диск-layout `orgs/<orgId>/projects/<projectId>/content`, ветка `users/<ownerId>/...` умирает. Существующие `apps/backend/repos/users/*` — дев-данные, не мигрируются, доступ к org-less строкам закрывается (404).

Допущения (из решений пользователя, не менять):
- D1. Авто-орг при register: транзакция org + membership owner/maintainer; API проектов по-прежнему требует orgId.
- D2. Disk: `resolveProjectDirectory` переписать на `resolveOrgStrict`, убрать зависимость пути от создателя.
- D3. Дев-данные не мигрировать; org-less строки → недоступны.
- D4. Сейчас только план + Trello-декомпозиция, реализация отдельным вызовом.

## Evidence Found
- Пока только заявления пользователя + AGENTS.md scope-правила (`processes/ → organizations/ → common/`, `common/` один Global модуль, вложенные модули только `<parent>/modules/<sub>/`).
- Текущее состояние пересказано пользователем (проверить в Epoch 2): POST /projects уже требует orgId (projects.controller.ts:107-110, projects.service.ts:326), POST /organizations доступен любому аутентифицированному (organizations.service.ts:119-200).

## Decisions
- Decision: глубина плана — high (6 эпох + PLAN.md с Trello-карточками, зависимости Blocked by).
- Rationale: 7 групп работ с конфликтами (БД, storage, доступ, контракты, auth, фронт, тесты) требуют evidence + validation.

## Confirmed Plan Items
1. Эволюция через эпохи 1→6, каждая заземлена на предыдущую — причина: traceable decisions, артефакт `.plans/org-only-lynx-42/epoch-0N.md`, валидация чтением кода.
2. Финальные артефакты: `PLAN.md` (последовательность + карточки) + `evolution-log.md` — причина: требование задачи, валидация наличием файлов.

## Open Questions
- Точный список файлов/строк противоречий (проверить чтением кода).
- Судьба `owner_id`, `GET /workspaces` + clone, нейминг персональной орги — вынести в открытые вопросы плана.
- Scope-правила для новых файлов (куда класть auto-org логику, чтобы не нарушить слои).

## Next Epoch Focus
- Epoch 2: собрать доказательства — прочитать schema.ts, project-access.service.ts, projects.service.ts, workspace-path.service.ts, контракты, auth register, фронт хуки, тесты, доки.
