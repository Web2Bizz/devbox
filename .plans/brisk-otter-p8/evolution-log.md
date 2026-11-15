# Evolution log — brisk-otter-p8

| Epoch | Decision / finding | Status |
|---|---|---|
| 01 | Criterion = `updatedAt`; column exists; feature needs contract + read + write + UI | accepted |
| 02 | `listLocalSessions` selects `createdAt` only; `SessionInfo` has no `updatedAt`; `appendMessage` never bumps; 11 affected files incl. 5 test surfaces | accepted |
| 02 | Mobile/running tab not affected; fake-drizzle ignores `orderBy` and lacks `id` filter | accepted |
| 03 | `updatedAt` is required in openapi/TS/zod | accepted |
| 03 | Order: `updated_at DESC, created_at DESC` tie-break | accepted |
| 03 | Bump in `appendMessage` with uuid guard; `ses_*` no-op | **conflict resolved** — plain `eq` would 503 on uuid cast |
| 03 | Create literal gets `updatedAt`; fork inherits | accepted |
| 03 | Frontend sorts a copy in `useSessions`; sidebar renders `updatedAt` | accepted |
| 03 | Complexity high 14.7 / risk low 1/8 → build-smart + 4-factor matrix | accepted |
| 04 | Tests are part of the change: fake-drizzle `desc`+`id`, e2e explicit `updatedAt` | accepted |
| 04 | No DB migration, no fallbacks, targeted commands frozen | accepted |

## Superseded
- Epoch 1 assumption "bump может быть простым `eq(id, sessionId)`" — superseded in
  epoch 3 by the uuid-guard decision.
- Epoch 1 "frontend sort maybe unnecessary" — kept as defensive sort (cache /
  optimistic inserts) in epoch 3.

## Open questions
None. All resolved or explicitly declared non-goals.
