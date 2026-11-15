# PLAN — Сортировка чатов rush-code по последней активности (`updatedAt`)

Source: Stanza card `cmw68mpt8000mp90zy3jfvm0e`
«Сделать сортировку чатов в rush-code от нового к старым»
Tag: `web2bizz/rush-code` (`cmw68o533000tp90zd4mri4il`), column `planned`.
Branch: `feat/cli-cloud-chat`.

## Goal
`GET /api/v1/sessions` отдаёт `updatedAt` (ISO-8601) и сортирует по нему
`DESC`; новое сообщение поднимает чат наверх; фронтовый список и подпись
времени используют `updatedAt`; openapi ↔ contracts ↔ backend ↔ frontend
согласованы.

## Non-goals
- Миграция БД (колонка `project_sessions.updated_at` уже есть).
- Мобильное приложение (использует upstream `Session`, не `SessionInfo`).
- `running-sessions-tab` (времени не рисует).
- Смена агента как активность (bump только на сообщениях).

## Decisions (final)
1. `updatedAt` — **required** во всех трёх контрактах (не optional).
2. Backend order: `updated_at DESC, created_at DESC` (детерминированный tie-break).
3. Bump — в `appendMessage`, тем же `try/catch`; **uuid-guard** обязателен,
   иначе `ses_*` даёт Postgres `22P02` → 503.
4. `create` — единственный литерал `SessionInfo` получает `updatedAt`.
5. Frontend сортирует копию в `useSessions`, sidebar рисует `updatedAt`.
6. Тесты входят в изменение: fake-drizzle учится `desc(updated_at)` и `id`,
   e2e-фикстуры получают явный `updatedAt`.

## Complexity / risk
- complexity: **high** (score 14.7; cards 4, files 11, deps 4, type update).
- risk: **low** (1/8; `breaking` 1 — аддитивное, но required поле публичного
  контракта; data/security/external 0).
- route: **build-smart**; complex → 4-factor matrix соблюдена (см. epoch-03).

## Card sequence

### 1. Contracts — `Добавить updatedAt в SessionInfo (openapi + zod)`
- **Layer:** shared · **Nesting:** root · **Blocked by:** —
- **Files:** `contracts/openapi.yaml`, `packages/contracts/src/sessions/sessions.ts`,
  `packages/contracts/src/sessions/sessions.schema.ts`
- **Checklist:**
  - openapi `SessionInfo`: required + property `updatedAt` (`date-time`, описание «последняя активность»)
  - `sessions.ts`: поле `updatedAt: string` + doc
  - `sessions.schema.ts`: `z.iso.datetime` с тем же сообщением, что у `createdAt`
  - `cd packages/contracts && bun run lint`

### 2. Backend — `Сортировать сессии по updatedAt desc и бампать при сообщении`
- **Layer:** service · **Nesting:** branch · **Blocked by:** card 1
- **Files:** `apps/backend/src/processes/modules/ai/modules/sessions/session-history.repository.ts`,
  `.../__tests__/session-history.repository.spec.ts`,
  `.../session-harness.service.ts`, `.../__tests__/sessions.e2e.ts`
- **Checklist:**
  - `listLocalSessions`: select `updatedAt`, `orderBy(desc(updatedAt), desc(createdAt))`
  - `toSessionInfo`: `updatedAt.toISOString()`
  - `appendMessage`: uuid-guard + `update project_sessions set updated_at = now()` после insert
  - `create`: `updatedAt: new Date().toISOString()`
  - fake-drizzle: `id` в `filterRows`, разбор `desc` в `orderBy`, 3 новых теста (порядок / bump / `ses_*` no-op)
  - e2e: явный `updatedAt` в фикстурах (B новее A → порядок отличается от `createdAt asc`), assert ISO
  - `bunx nx run backend:build && bun dist/.../session-history.repository.spec.js`
  - `bun scripts/e2e.ts sessions.e2e` (Docker) — если доступен

### 3. Frontend — `Сортировать чаты по updatedAt и показывать последнюю активность`
- **Layer:** widgets (+ shared hook) · **Nesting:** branch · **Blocked by:** card 2
- **Files:** `apps/frontend/src/hooks/useSessions.ts`,
  `apps/frontend/src/components/projects/sessions-sidebar/sessions-sidebar.tsx`,
  `apps/frontend/src/components/projects/__tests__/sessions-sidebar.test.tsx`,
  `apps/frontend/src/api/__tests__/sessions-client.test.ts`
- **Checklist:**
  - `useSessions`: `useMemo` → копия, `updatedAt desc`, tie `createdAt desc`/`id`
  - sidebar: `formatRelativeTime(s.updatedAt)` + `<time dateTime={s.updatedAt}>`
  - фикстуры `updatedAt`; drift-тест «нет updatedAt → shape_mismatch»; assert `<time datetime>`
  - `cd apps/frontend && bun run lint && bun test src/components/projects/__tests__/sessions-sidebar.test.tsx src/api/__tests__/sessions-client.test.ts`

### 4. Verify / done — `Проверить сортировку чатов end-to-end`
- **Layer:** app (cross-cut) · **Nesting:** leaf · **Blocked by:** cards 2, 3
- **Checklist:**
  - `tools.check` на diff
  - `bun run lint` в корне
  - целевые спеки + `sessions.e2e`
  - curl: `updatedAt` есть, порядок non-increasing; после сообщения чат первый
  - UI: новый чат сверху, время = последняя активность
  - parity openapi ↔ `SessionInfo` ↔ `sessionInfoSchema`

## Error handling
- `ses_*`/не-uuid id → update пропускается, ошибки нет.
- Сбой БД → прежний `dbUnavailable` → 503 `EXTERNAL_UNAVAILABLE` (без фолбэков).
- Строгий zod: старый backend без поля → `shape_mismatch` (loud), поэтому
  contracts+backend+frontend выкатываются вместе.
- Равные `updatedAt` → tie-break по `created_at`, затем фронт по `id`.
- Невалидный ISO на фронте → `formatRelativeTime` возвращает `null` (без выдумок).

## Verification commands
```bash
cd packages/contracts && bun run lint
bunx nx run backend:build
bun apps/backend/dist/processes/modules/ai/modules/sessions/__tests__/session-history.repository.spec.js
bun apps/backend/scripts/e2e.ts sessions.e2e        # Docker
cd apps/frontend && bun run lint
cd apps/frontend && bun test src/components/projects/__tests__/sessions-sidebar.test.tsx src/api/__tests__/sessions-client.test.ts
```

## Definition of Done
См. epoch-04. Коротко: поле в трёх контрактах, `DESC`-порядок, bump на
сообщении, uuid no-op, фронт сортирует и рисует `updatedAt`, lint/specs/check
зелёные, без миграции и фолбэков.
