# Epoch 3: Decisions — contract, write semantics, conflict resolution

## Conflict found and resolved (blocking)

**`eq(projectSessions.id, sessionId)` is unsafe for upstream ids.**
`project_sessions.id` is `uuid`; `session_messages.session_id` is `text` and its
documented domain includes upstream `ses_*`. Postgres would raise
`22P02 invalid input syntax for type uuid`, `dbUnavailable` would wrap it as
503 `EXTERNAL_UNAVAILABLE`, and **every message on such a session would fail** —
the opposite of the "no-op" the task assumes.

- **Decision:** guard the update with a local UUID regex; only uuid session ids
  hit `update project_sessions ... where id = $1`. Non-uuid (`ses_*`) is a
  deliberate no-op, still inside the same `try/catch`.
- **Alternatives rejected:**
  - `sql`${projectSessions.id}::text = ${sessionId}`` — no error, but forces a
    seq scan on `project_sessions` for every message and hides the id-domain
    boundary.
  - Swallowing the Postgres error — would mask real DB failures.
  - Using `eq` unconditionally — 503 risk described above.

## Decisions

1. **Contract field is required, not optional** (`updatedAt: string`, ISO-8601).
   Rationale: the backend always emits it (DB `NOT NULL DEFAULT now()`); optional
   would force `?? createdAt` fallbacks in every consumer and hide drift.
   Consequence: frontend zod parsing of an old backend fails loudly — acceptable
   in a monorepo released together (mobile uses the upstream `Session`, not
   `SessionInfo`). Mitigation: deploy contracts+backend+frontend together.
2. **Ordering:** `orderBy(desc(projectSessions.updatedAt), desc(projectSessions.createdAt))`.
   Tie-breaker makes equal timestamps deterministic (e2e fixtures, same-ms
   messages).
3. **Bump point:** `appendMessage` after the insert, same `try/catch`. Messages
   are the only activity the chat list cares about; agent switching stays out of
   scope (a follow-up if product wants it). Two statements are intentionally not
   wrapped in a transaction: a failed bump surfaces as 503 and the insert is
   idempotent on retry (`onConflictDoNothing`).
4. **Create:** add `updatedAt: new Date().toISOString()` to the single
   `SessionInfo` literal in `session-harness.service.ts` (`create`). Fork reuses
   it. `saveLocalSession` keeps DB defaults; the millisecond drift does not
   affect ordering.
5. **Frontend sort:** sort a **copy** in `useSessions` (`[...data].sort`), not in
   the component and never in-place on the react-query cache. Tie-break by
   `createdAt` desc, then `id`. The sidebar renders `formatRelativeTime(s.updatedAt)`
   and `<time dateTime={s.updatedAt}>`; the API sort remains the primary source.
6. **No DB migration.** The column exists; only code changes.
7. **Tests are part of the change, not follow-up:** the fake-drizzle must model
   `desc(updated_at)` and the `id` predicate; e2e fixtures get explicit
   `updatedAt` that contradicts `createdAt` order, proving the new sort.

## Complexity / risk (evol-plan formula)

- cards 4, files 11, deps 4, type `update` (2), unknowns 0, risk_score 1.
- `score = 4 + 11*0.2 + 4*1.5 + 2 + 0 + 1*0.5 = 14.7` → **high**.
- Risk: `breaking` 1 (additive-but-required public field + strict zod), `data` 0,
  `security` 0, `external` 0 → **low (1/8)**.
- `complex = high` → card 4-factor matrix applies; build route **build-smart**.
  Mitigation: deploy together, e2e shape assertions, no schema loosening.
- Files: openapi.yaml; sessions.ts; sessions.schema.ts; session-history.repository.ts;
  session-history.repository.spec.ts; session-harness.service.ts; sessions.e2e.ts;
  useSessions.ts; sessions-sidebar.tsx; sessions-sidebar.test.tsx;
  sessions-client.test.ts.

## Closed 4-factor matrix (one row per card context)

| Card | Routing | Role | Layer | Nesting |
|---|---|---|---|---|
| 1. Contracts | `auth` (existing guarded API; response shape) | `user` | `shared` | `root` (in=0, out=1) |
| 2. Backend | `auth` | `user` | `service` | `branch` (in=1, out=2) |
| 3. Frontend | `auth` | `user` | `widgets` (+ `shared` hook) | `branch` (in=1, out=1) |
| 4. Verify | `auth` | `user` | `app` (cross-cut) | `leaf` (in=2, out=0) |

Access criteria to repeat in cards 1–2: guest → `401`; authenticated non-member
`projectId` → `404` (C4 gate, no existence leak). Role `user` only — no
`admin/owner` semantics on these routes.

## Reuse-first
- Reuse the existing `createdAt` ISO convention (`toISOString` + `z.iso.datetime`)
  instead of a new timestamp type.
- Reuse `sessionsQueryKey`/react-query cache; no new cache key.
- Reuse the single `SessionInfo` literal in `create` (fork inherits it).
- Reuse the existing fake-drizzle harness; extend it, do not introduce a new one.
- No shared-package modification beyond `@rush-code/contracts` (owned here).

## Next Epoch Focus
Freeze the implementation checklist, exact verification commands, error handling,
and Definition of Done for the four cards.
