# Epoch 3: Decision foundation — конфликты и развилки

## Hypothesis
Три развилки блокируют детализацию: (A) судьба `owner_id`, (B) судьба legacy `GET /workspaces` + clone, (C) нейминг/идемпотентность персональной орги + размещение по scope-правилам.

## Evidence Found
- File: `schema.ts:58 ownerId text` — текстовый ключ (не uuid FK), используется как диск-ключ через `ownerKeyOrThrow` + `SYSTEM_OWNER_UUID`-коалесцинг для NULL.
- File: `projects.service.ts` layout-doc — ownerId immutable, т.к. от него производится путь; переименование отвергнуто (no silent data moves).
- File: `project-access.service.ts:209-273` — owner-equality fallback существует и в орг-ветке (creator is maintainer in practice).
- Scope-правила (AGENTS.md): `processes/ → organizations/ → common/`, стрелка только вниз; `common/` — один Global модуль, без `*.module.ts` в подпапках; вложенные модули только `<parent>/modules/<sub>/`.

## Decisions
- Decision A (рекомендуемый): `owner_id` ОСТАВИТЬ как `createdBy` audit (кто создал), убрать его роль в storage/access. Миграция: `org_id SET NOT NULL` + CHECK/валидация, `owner_id` оставить nullable text без NOT NULL (legacy NULL-строки остаются, новые ряды всегда пишут creator id), добавить комментарий «audit only, never used for path/authz». Update продолжает reject смену (400) — теперь как immutable audit.
  - Alternatives considered: A2 удалить колонку полностью (DROP) — rejected: теряется аудит, требует тяжёлой миграции + переписывания enrich/DTO, риск для chats/sessions истории; A3 переименовать в `created_by` — rejected на этом этапе (rename = downtime + фронт/контракт churn, можно позже отдельной карточкой).
  - Rationale: минимальная блокирующая миграция, дев-данные не трогаем (D3), путь больше не зависит от создателя (D2).
- Decision B (рекомендуемый): legacy `GET /workspaces` (user-space дерево) и clone через `users/<userId>/projects/<repoName>` — УБРАТЬ user-space путь: либо 410 Gone (как link/unlink прецедент `organizations.service.ts:312-324`), либо перевести на org-scoped (`orgs/<orgId>/projects/<id>`) если фича жива. В план заложить оба исхода как подзадачи карточки 2 с явным выбором при реализации (дефолт — 410 Gone для GET user-space + clone переписать на org).
  - Alternatives considered: оставить как есть — rejected, нарушает целевое состояние (диск только orgs/).
  - Rationale: прецедент Gone уже есть в кодбазе, fail-closed.
- Decision C (нейминг): персональная орга — `name = "<firstName>’s workspace"` (fallback `"Personal workspace"` при пустом имени), `isPrivate=true`, `description=null`. Идемпотентность: register-транзакция проверяет существующий membership/оргу по `(ownerId, name)` или повторный вызов createLocal с тем же email → 409 до создания орги; плюс unique-частичный индекс не трогаем — идемпотентность за счёт «register — одна транзакция users + orgs + members; повторный register с тем же email → 409, без сиротских орг».
  - Alternatives considered: имя = email-prefix / `personal-<uuid>` — rejected/huже UX, но зафиксировать как fallback-вариант в открытом вопросе.
  - Rationale: человекочитаемо, приватно по умолчанию, соответствует `organizations.service.create` (owner-as-maintainer транзакция — переиспользовать паттерн).
- Decision D (scope-размещение): auto-org логика живёт в `organizations/` (например `organizations/modules/personal/` или метод `OrganizationsService.createPersonal`), вызывается из `auth/` (auth — верхний слой, вызов вниз в organizations разрешён; обратного вызова organizations→auth/processes нет). Никакого нового `*.module.ts` в `common/`; если нужен кросс-доменный хелпер (нейминг) — чистая функция в `organizations/utils/` или `common/utils/<name>/` без модуля. Диск-хом для орги — существующий `ensureOrgScope`.
  - Alternatives considered: класть в `auth/` напрямую с SQL — rejected (нарушает слои, дублирует транзакцию org+member); класть в `common/` — rejected (common не знает доменов).
  - Rationale: соответствует scope-правилам из задачи.

## Confirmed Plan Items
1. Зафиксировать D1-D4 пользователя как non-negotiable в PLAN.md — причина: явное требование, валидация цитатой.
2. Карточки строить на решениях A/B/C/D выше — причина: без них реализация разойдётся.

## Open Questions (вынести в PLAN.md отдельно, не решать кодом сейчас)
- Q1 owner_id: оставить audit (рекомендовано) vs дропнуть — финальное слово за реализацией карточки 1.
- Q2 судьба GET /workspaces + clone: 410 Gone vs org-scoped переписывание.
- Q3 нейминг персональной орги: `"<first>’s workspace"` vs email-based vs `personal-<suffix>`; идемпотентность при ретрае register (транзакция vs компенсация).

## Next Epoch Focus
- Epoch 4: детализировать карточки 1-3 (БД+миграция, storage/jail, доступ) до уровня файлов/функций/критериев.
