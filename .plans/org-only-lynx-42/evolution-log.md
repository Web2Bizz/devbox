# Evolution log — org-only-lynx-42

| Epoch | Decision | Rationale | Status |
|-------|----------|-----------|--------|
| 01 | Глубина high (6 эпох + PLAN.md с Trello-карточками) | 7 групп работ с конфликтами требуют evidence+validation | kept |
| 01 | D1-D4 пользователя — non-negotiable | Явное требование задачи | kept |
| 02 | Порядок 1 БД → 2 storage → 3 доступ → 4 контракты → 5 auth → 6 фронт → 7 тесты | Каждый слой зависит от предыдущего | kept |
| 03-A | `owner_id` ОСТАВИТЬ как createdBy audit (рекомендация), не DROP | Минимальная миграция, сохраняется аудит, путь больше не зависит от него | kept (финал — карточка 1, Q1) |
| 03-B | Legacy workspaces/clone: 410 Gone (дефолт) или org-scoped | Прецедент link/unlink Gone, fail-closed | kept (финал — карточка 2, Q2) |
| 03-C | Нейминг `"<first>’s workspace"` / `Personal workspace`, `isPrivate=true`, идемпотентность через 409 | UX + переиспользование org-create паттерна | kept (финал — карточка 5, Q3) |
| 03-D | Auto-org в `organizations/` (createPersonal), вызов `auth→organizations→common` | Scope-правила: стрелка вниз, common без доменов, без новых common-модулей | kept |
| 04 | Карточка 1 без data-migration; gate 404ит org-less | D3 дев-данные не трогаем | kept |
| 04 | `resolveUser` методы оставить dead-code (дефолт), убрать вызовы | Минимальный diff | kept (финал — карточка 2) |
| 04 | Убрать owner-equality fallback в орг-ветке (строго member-only) | Целевое состояние: только организация решает доступ | kept |
| 05 | `orgId: string` non-null везде + YAML синхронно; `orgId` immutable в update | YAML — источник правды | kept |
| 05 | Register — одна транзакция user+org+member + `ensureOrgScope` с rollback | Паттерн `organizations.create:152-200` | kept |
| 05 | Фронт: `useProjects` удалить/обёртка, диалог только с orgId, personal default | Контракт non-null + personal org | kept |
| 06 | Карточка 7: e2e register→personal→project→404-матрица + secret-скан + доки + scope-gate | Инварианты org-only доказываются тестами | kept |

Superseded: нет (все решения Epoch 1-3 сохранены, уточнены в 4-6 без отмен).
Conflicts encountered: нет блокирующих (Q1/Q2/Q3 отложены как открытые вопросы с рекомендациями, не стопают план).
