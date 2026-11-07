# Epoch 1: Coarse hypothesis

## Hypothesis
Донор `/media/codebase/@letnull19a/opencode` (v2.2.5, Effect/Hono/Drizzle) содержит 7 целевых capabilities: инструменты, циклы (loop/runner), агенты, снапшоты FS, undo (revert stage/clear/commit), fork сессий, revert messages. Приёмник — Rush Code monorepo (NestJS backend :3100, Next.js frontend :3001, contracts-пакет, CLI отдельно). Порт — не перенос Effect/Hono, а переписывание семантики на NestJS+Zod+Drizzle(pg) с сохранением wire-совместимости через `@rush-code/contracts` + `contracts/openapi.yaml`.

## Evidence Found
- File: `.tmp/opencode-overview.md` — карта донора: `packages/ai` (llm/loop/tool-runtime), `packages/core` (session/agent/tool/snapshot), `packages/schema` (zod-контракты), `packages/protocol` (wire), `packages/server` (Hono).
- Pattern: приёмник уже имеет задел — `apps/backend/src/processes/modules/ai/modules/sessions/` (SessionsService→SessionHarnessService→OpencodeHostService), `modules/agents/` (ask/auto/backend/frontend/fullstack), `modules/opencode/` (host), `packages/contracts/src/sessions/`, `apps/frontend/src/api/sessions-client.ts` + guard `no-opencode-transport.test.ts`.

## Decisions
- Decision: портировать только семантику 7 функций, без Effect/Solid/Hono/PTY/Rust-демона/MCP-browser/desktop.
- Alternatives considered: полный перенос Effect-слоёв — rejected (чужой runtime, конфликт с NestJS DI и scope-правилами).
- Rationale: scope-правила backend (processes→organizations→common, common — один @Global) и contracts-канон (openapi.yaml — источник правды) требуют нативной реализации.

## Confirmed Plan Items
1. Инструменты: dispatch/runTools семантика — reason, artifact: backend `processes/modules/ai/modules/tools/`, validation: spec на unknown-tool + invalid-input.
2. Циклы: pendingCalls/nextRequest/stepMessages/collect/addUsage + runner step/retry/max-steps — reason, artifact: backend harness/runner, validation: e2e interrupt/stop.
3. Агенты: registry resolve/select/list + subagent-инкапсуляция — reason, artifact: backend `modules/agents/` расширение, validation: controller security spec.
4. Снапшоты/undo/fork/revert-messages: capture/diff/restore + stage/clear/commit + fork(before/through) — reason, artifact: backend sessions + contracts + frontend, validation: e2e + SSE.

## Open Questions
- Точный объём tool-сета MVP (все 19 plugin-инструментов или подмножество read/write/edit/glob/grep/shell/patch/todo?).
- Снапшоты на git-дереве vs упрощённый diff через WorkspacePathService + Drizzle?
- Fork копирует историю из SQLite донора — в приёмнике история где (session-history.repository.ts, pg или файловый harness)?

## Next Epoch Focus
- Evidence gathering: прочитать donor tool/plugin файлы, runner/*, agent schema, protocol session group, receiver harness/service/history/controller.
