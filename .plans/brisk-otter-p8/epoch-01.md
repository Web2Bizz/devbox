# Epoch 1: Coarse hypothesis — chat list newest-first by last activity

## Target state
`GET /api/v1/sessions` returns sessions ordered newest-first by the last activity
(`updatedAt`), and the frontend chat list (sidebar) renders in the same order and
shows the last-activity time. A new user/assistant message must move its chat to
the top.

Source card: Stanza `cmw68mpt8000mp90zy3jfvm0e` — «Сделать сортировку чатов в
rush-code от нового к старым». Confirmed criterion: `updatedAt` (not `createdAt`).

## Hypothesis (obvious assumptions)
- `project_sessions.updated_at` already exists (no migration required).
- Today the list is `ORDER BY created_at ASC` and the field is not exposed in the
  wire contract, so neither the API nor the UI can sort by activity.
- `updated_at` is not bumped when chat messages arrive, so exposing it without
  writing to it would still sort by creation — the bump is part of the feature.
- Contracts are the source of truth (`contracts/openapi.yaml` → `@rush-code/contracts`
  → backend/frontend), so the field must be added there first.

## Coarse steps
1. Contracts: add `updatedAt` (ISO-8601) to `SessionInfo` (openapi + TS + zod).
2. Backend: select `updated_at`, order `DESC`, map to ISO; bump `updated_at` in
   `appendMessage`; set it on create.
3. Frontend: sort the list defensively by `updatedAt` desc; render relative time
   from `updatedAt` (both `formatRelativeTime` argument and `<time dateTime>`).
4. Verify: lint, targeted specs/e2e, `tools.check`, openapi↔contracts↔code parity.

## Open questions for Epoch 2
- Does `appendMessage` ever receive an upstream `ses_*` id (not a uuid)? If yes,
  `eq(project_sessions.id, sessionId)` may raise a Postgres uuid cast error.
- Which tests/fixtures construct `SessionInfo` and will break once the field is
  required (`sessions-client.test.ts`, `sessions-sidebar.test.tsx`,
  `session-history.repository.spec.ts`, `sessions.e2e.ts`)?
- How does the fake-drizzle spec emulate `orderBy`? Can it express `desc`?
- Is there any consumer besides the web sidebar (mobile, running tab) that must
  change?

## Next Epoch Focus
Read the exact code paths and test fakes, confirm the uuid risk, and enumerate
every affected fixture.
