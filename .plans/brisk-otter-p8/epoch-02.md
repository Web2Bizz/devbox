# Epoch 2: Evidence — exact paths, shapes, and impacted tests

## Hypothesis validated
The feature is a three-layer change (contracts → backend → frontend) plus test
fixtures. The DB column already exists; only the read/write path and the wire
shape are missing.

## Evidence Found

### Backend — read path
- `apps/backend/src/processes/modules/ai/modules/sessions/session-history.repository.ts:302-328`
  `listLocalSessions` selects `id/projectId/metadata/createdAt/agentId` and does
  `orderBy(asc(projectSessions.createdAt))`. `updatedAt` is not selected.
- `.../session-history.repository.ts:349-367` `toSessionInfo` maps the row to
  `SessionInfo`; no `updatedAt` in the projection.
- `apps/backend/src/common/db/schema.ts:102-125` `project_sessions` has
  `updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()`
  → **no migration needed**.
- `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts:288-295`
  `list()` is a thin pass-through to `history.listLocalSessions`.
- `.../session-harness.service.ts:320-331` — the only literal `SessionInfo`
  construction (`create`); fork reuses `create`, so one literal covers create+fork.

### Backend — write path
- `.../session-history.repository.ts:38-65` `appendMessage` inserts into
  `session_messages` with `onConflictDoNothing` and no `project_sessions` write.
  It is the single durable write point for user/assistant rows.
- Call sites (all in `session-harness.service.ts`): 513, 557, 625, 652, 782, 941,
  1372. Today they pass the local harness uuid, but the table comment
  (`schema.ts:128-135`) explicitly documents `session_messages.session_id` as a
  **text domain id** that may be upstream `ses_*`. Guard needed (see Epoch 3).
- `setHostSessionId` (`repository.ts:152-170`) and `discardSession` (`263-272`)
  already bump `updatedAt` — so the column is not dead, only message activity is
  missing.
- `saveLocalSession` (`repository.ts:275-299`) inserts without explicit
  `createdAt/updatedAt` → DB defaults apply.

### Contracts
- `packages/contracts/src/sessions/sessions.ts:53-72` `SessionInfo` — no `updatedAt`.
- `packages/contracts/src/sessions/sessions.schema.ts:80-96` `sessionInfoSchema`
  — strict zod object; a required `updatedAt` makes old responses fail
  `shape_mismatch` (loud, by design).
- `contracts/openapi.yaml:3074-3113` `SessionInfo`: `required: [id, title,
  createdAt, directory, projectId, model, agentId, status]`, no `updatedAt`.
- `packages/contracts/AGENTS.md`: openapi.yaml is the source of truth; TS/zod must
  mirror it field-for-field.

### Frontend
- `apps/frontend/src/hooks/useSessions.ts:97-124` query → `data`; line ~201
  `const sessions = data ?? []` — no sorting, no memo.
- `apps/frontend/src/components/projects/sessions-sidebar/sessions-sidebar.tsx:152-170`
  uses `formatRelativeTime(s.createdAt, ...)` and `<time dateTime={s.createdAt}>`.
- `apps/frontend/src/components/projects/running-sessions-tab/running-sessions-tab.tsx`
  renders no time at all → out of scope.
- `apps/mobile/.../backend-contracts.ts` uses the upstream `Session` shape
  (`{id,title,createdAt}`), **not** `SessionInfo` → mobile unaffected.

### Tests / fixtures that will break or must grow
- `apps/backend/.../__tests__/session-history.repository.spec.ts`
  - fake-drizzle `result().orderBy` (lines ~156-174) **ignores its argument** and
    always sorts `createdAt` asc → must learn `updated_at` + direction.
  - fake `filterRows` (lines ~148-154) handles `project_id/origin/deleted_at`
    only → an `id` predicate would match **all** `projectSessions` rows; add `id`.
  - `listLocalSessions` test (359-401) seeds an `upstream` row and asserts the
    harness row mapping; no order/updatedAt assertion yet.
- `apps/backend/.../__tests__/sessions.e2e.ts:96-124` inserts two sessions with
  `createdAt` only → `updatedAt` defaults to `now()` for both (tie, unstable).
  Assertions at 247-270 expect `rows[0] = SESSION_A` / `rows[1] = SESSION_B`.
- `apps/frontend/src/api/__tests__/sessions-client.test.ts:93-121` `ROW` fixture
  and the shape-drift test (missing `createdAt`).
- `apps/frontend/src/components/projects/__tests__/sessions-sidebar.test.tsx:29-42`
  `sessionInfo()` fixture.
- `apps/backend/.../__tests__/sessions.service.spec.ts:125` fake returns `[{id}]`
  — tolerant, no change expected.

## Pattern to follow
- ISO timestamps at the boundary: `createdAt: row.createdAt.toISOString()` and
  `z.iso.datetime(...)` (already the convention for `createdAt`/`message.createdAt`).
- Every DB failure goes through `dbUnavailable(...)` (throws 503, never a silent
  fallback) — keep the same `try/catch`.

## Open questions for Epoch 3
- How to bump `updated_at` for a non-uuid `sessionId` without producing a 503.
- Whether ordering needs a tie-breaker (`created_at DESC`).
- Where exactly to sort on the frontend (hook vs component) so the cache is not
  mutated.

## Next Epoch Focus
Turn the evidence into decisions, resolve the uuid conflict, and freeze the test
contract.
