# Epoch 4: Validation — exact plan, tests, error handling, DoD

## Card 1 — Contracts (root)

**Files**
- `contracts/openapi.yaml` (`SessionInfo`, ~3074-3113)
- `packages/contracts/src/sessions/sessions.ts` (`SessionInfo`, 53-72)
- `packages/contracts/src/sessions/sessions.schema.ts` (`sessionInfoSchema`, 80-96)

**Items**
1. openapi: append `updatedAt` to `required`, add property
   `{ type: string, format: date-time }` with description
   "ISO-8601 timestamp of the last activity (message append / binding change)".
2. `sessions.ts`: `updatedAt: string;` with a doc comment next to `createdAt`.
3. `sessions.schema.ts`: `updatedAt: z.iso.datetime({ error: 'Field "updatedAt"
   must be an ISO-8601 timestamp' })` (same strictness as `createdAt`).
4. Keep the file header claim "mirrors openapi field-for-field" true.

**Acceptance**
- `cd packages/contracts && bun run lint` (tsc + biome) is green.
- `sessionInfoSchema.parse({...ROW, updatedAt})` passes; missing `updatedAt` fails
  with a zod issue (loud).
- `grep -n updatedAt` shows exactly one property in each of the three sources.

## Card 2 — Backend (branch)

**Files**
- `apps/backend/src/processes/modules/ai/modules/sessions/session-history.repository.ts`
- `apps/backend/src/processes/modules/ai/modules/sessions/__tests__/session-history.repository.spec.ts`
- `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts`
- `apps/backend/src/processes/modules/ai/modules/sessions/__tests__/sessions.e2e.ts`

**Items**
1. Import `desc`; `listLocalSessions`: select `updatedAt: projectSessions.updatedAt`,
   `.orderBy(desc(projectSessions.updatedAt), desc(projectSessions.createdAt))`.
2. `toSessionInfo`: accept `updatedAt: Date`, emit `updatedAt: row.updatedAt.toISOString()`.
3. `appendMessage`: after the insert (still in the same `try`), bump
   `project_sessions.updated_at = new Date()` **only when `sessionId` matches
   the uuid regex** (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`).
   Non-uuid (`ses_*`) → no statement, no error. Keep `dbUnavailable` on failure.
4. `create`: add `updatedAt: new Date().toISOString()` to the sole `SessionInfo`
   literal (fork inherits it).
5. Spec fake-drizzle:
   - `filterRows` handles the `id` column for `projectSessions` (otherwise the
     update matches every row);
   - `result().orderBy` reads the order node: column via `referencedColumns`,
     direction from the SQL chunk (`desc`), falling back to `createdAt asc`;
   - new tests: (a) two rows with `updatedAt` order opposite to `createdAt` →
     `updatedAt`-newest first, ISO mapping; (b) `appendMessage` bumps only the
     matching uuid row; (c) `appendMessage({sessionId:'ses_upstream'})` issues no
     update and does not throw.
6. Sessions e2e: set explicit `updatedAt` in the two fixtures (make `SESSION_B`
   the newest so `rows[0]` flips versus the old `createdAt asc`), assert
   `updatedAt` ISO on both rows. Keep "list after create includes the row".

**Acceptance**
- `bunx nx run backend:build && bun dist/processes/modules/ai/modules/sessions/__tests__/session-history.repository.spec.js`
  prints all checks passed.
- `bun scripts/e2e.ts sessions.e2e` (needs Docker) is green; list order is
  `updatedAt desc`.
- `GET /api/v1/sessions` row carries `updatedAt`; guest → 401, non-member
  projectId → 404.
- Error handling: a `ses_*` append does not produce a 503; a DB outage still
  maps to 503 `EXTERNAL_UNAVAILABLE`.

## Card 3 — Frontend (branch)

**Files**
- `apps/frontend/src/hooks/useSessions.ts`
- `apps/frontend/src/components/projects/sessions-sidebar/sessions-sidebar.tsx`
- `apps/frontend/src/components/projects/__tests__/sessions-sidebar.test.tsx`
- `apps/frontend/src/api/__tests__/sessions-client.test.ts`

**Items**
1. `useSessions`: replace `const sessions = data ?? []` with a `useMemo` over a
   copy sorted by `updatedAt` desc, tie-break `createdAt` desc then `id`
   (defensive against cached/optimistic rows; never mutate `data`).
2. Sidebar: `formatRelativeTime(s.updatedAt, ...)` and
   `<time dateTime={s.updatedAt}>`.
3. Tests: add `updatedAt` to `ROW` (sessions-client) and `sessionInfo()`
   (sidebar); add a shape-drift test "row without updatedAt → shape_mismatch";
   assert the rendered `<time>` `datetime` equals the fixture `updatedAt`.
4. Optional (recommended): extract the comparator as an exported pure helper and
   unit-test it without React.

**Acceptance**
- `cd apps/frontend && bun run lint` green.
- `cd apps/frontend && bun test src/components/projects/__tests__/sessions-sidebar.test.tsx src/api/__tests__/sessions-client.test.ts`
  green.
- Mocked unordered `useSessions` data renders newest-first (helper) and the time
  line reflects `updatedAt`.

## Card 4 — Verify / done (leaf)

**Items**
1. `tools.check` (`scripts/check/run.sh --json`) on the uncommitted diff.
2. `bun run lint` at repo root (contracts + backend + frontend).
3. Targeted specs from cards 2–3; `sessions.e2e` if Docker is available.
4. Live/curl check: `GET /api/v1/sessions?projectId=…` → `updatedAt` present and
   non-increasing; after sending a message, that session is first.
5. UI check: new chat message moves the chat to the top; the meta line shows the
   last-activity time.
6. Parity check: openapi `required`/properties ↔ `SessionInfo` ↔ `sessionInfoSchema`
   (no field omitted in any of the three).

**Definition of Done**
- [ ] `updatedAt` is required in openapi, TS and zod, with identical semantics.
- [ ] List is `updatedAt desc` (tie `createdAt desc`) in the repository.
- [ ] New user/assistant message bumps `project_sessions.updated_at`.
- [ ] Upstream `ses_*` ids are a no-op (no 503 regression).
- [ ] Frontend sorts defensively and renders `updatedAt`.
- [ ] Lint, targeted specs and `tools.check` are green.
- [ ] No migration, no schema loosening, no silent fallback.

## Validation risks
- `updatedAt` ties in fixtures/time-zone rounding → tie-breaker covers it.
- E2E requires Docker; if unavailable, record it as not-run, do not fake it.
- Strict zod makes an old backend response fail — release contracts + backend +
  frontend together (monorepo).
- The fake-drizzle is shared by other tests; changing `orderBy` must keep the
  `createdAt asc` default for `listMessages`.

## Next Epoch Focus
Finalize `PLAN.md` + card payloads (Stanza), no further open questions.
