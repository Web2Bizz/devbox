# Epoch 2: Evidence gathering

## Hypothesis
Детали донора и точки встраивания приёмника подтверждаются чтением кода.

## Evidence Found
- File: donor `packages/core/src/tool/plugin/` — 19 инструментов: `read/write/edit/glob/grep/shell/patch/file-diff/todo/skill/subagent/question/mcp-resource/schedule/webfetch/websearch/image-generate/artifact/opencode` + `tool/runtime.ts`, `read-filesystem.ts`, `search.ts`, `mcp.ts`.
- File: donor `packages/ai/src/loop.ts` — `pendingCalls(response, answerTool?)`, `nextRequest`, `stepMessages`, `addUsage`, `collect(stream)` (fold step-start/step-finish/tool-result/finish); `packages/ai/src/tool-runtime.ts` — `dispatch(tools, call)` (name=`ns.name`, decode→execute→encode→project, Tool.Error→error-result), `runTools` (concurrency unbounded, порядок вызовов сохранён).
- File: donor `packages/core/src/session/runner/` — `llm.ts/step.ts/max-steps.ts/retry.ts/prompt/to-llm-message.ts/publish-llm-event.ts`; цикл: forced toolChoice только первый шаг (кроме keepForcedChoice answer-инструмента), `length`-finish = терминальный.
- File: donor `packages/core/src/agent.ts` — registry `Map<ID,Info>`, `resolve/select/list`, default `build`, `mode==='subagent'` и `hidden` исключены из селекта; `packages/schema/src/agent.ts` — Info-контракт.
- File: donor `packages/core/src/snapshot.ts` (248 строк) — `capture/files/diff/restore`, git content-addressed tree в `<global>/snapshot/<project>/<hash>`, `enabled = vcs==='git' && state`, capture best-effort (warn+undefined), restore с jail-проверкой `FSUtil.contains`.
- File: donor `packages/core/src/session/revert.ts` (112 строк) — `stage(session,messageID,files?)` (plan по seq>boundary assistant-сообщений с snapshot.start, restore, diff, publish Staged), `clear` (restore original, publish Cleared), `commit` (publish Committed), `plan` (boundary seq lookup → MessageNotFoundError).
- File: donor `packages/core/src/session.ts:339` — `fork(sessionID, before?)` (boundary lookup → ForkEmptyError/MessageNotFoundError, `InstructionState.current+snapshot`, media blob от родителя, publish Forked с boundary {through|before}).
- File: donor `packages/protocol/src/groups/session.ts:258,470,486,495` — `POST /api/session/:id/fork`, `POST .../revert/stage`, `DELETE .../revert`, `POST .../revert/commit`; handlers `packages/server/src/handlers/session.ts:202,445,466,481`.
- File: receiver `apps/backend/src/processes/modules/ai/modules/sessions/sessions.service.ts` (102 строки) — thin facade → `SessionHarnessService`; controller 208 строк; `session-harness.service.ts` + `session-history.repository.ts` + `sessions.dto.ts` — точки встраивания.
- File: receiver `apps/backend/src/processes/modules/ai/modules/agents/` — `agents.service.ts` (41), registry + `ask/auto/backend/frontend/fullstack.agent.ts`, `agent.base.ts`.
- File: receiver `apps/backend/src/processes/modules/workers/modules/executor/` — `executor.ts` + `executor.registry.ts` (существующий исполнитель run-ов, не путать с tool-dispatch).
- File: receiver `packages/contracts/src/sessions/sessions.ts + sessions.schema.ts` — SessionInfo/SessionMessage/SendMessage/StreamFrame, zod v4 boundary, зеркало `contracts/openapi.yaml`.
- File: receiver `apps/frontend/src/api/sessions-client.ts` + `src/hooks/useChat.ts` (SSE-исключение, `session.step.ended`, stop()=abort+interrupt+partial) + guard `no-opencode-transport.test.ts`.

## Decisions
- Decision: MVP tool-сет = read/write/edit/glob/grep/shell/patch/todo/webfetch + инкапсулированный subagent-вопросник; schedule/image/mcp-resource — вторая очередь.
- Alternatives considered: все 19 сразу — rejected (MCP/schedule/image тянут внешние зависимости и PTY).
- Rationale: чат-прототип закрывается 8 инструментами + dispatch-контрактом, остальные добавляются тем же интерфейсом.

## Confirmed Plan Items
1. Tool dispatch по `dispatch/runTools` семантике с jail через WorkspacePathService — reason, artifact: backend, validation: spec unknown-tool/invalid-JSON/outside-jail.
2. Loop `pendingCalls/nextRequest/collect/addUsage` как чистые функции + runner step/retry/max-steps — reason, artifact: backend, validation: unit на fold + e2e stop/interrupt.
3. Agent registry расширить до resolve/select/list с default build и hidden/subagent фильтром — reason, artifact: backend agents, validation: security spec.
4. Snapshot capture/diff/restore поверх git worktree под REPOS_ROOT (best-effort capture, строгий restore) — reason, artifact: backend, validation: spec disabled-non-git + escape-path.
5. Revert stage/clear/commit + fork(before/through) + protocol-эндпоинты — reason, artifact: contracts+backend+frontend, validation: e2e fork→messages, revert→files.

## Open Questions
- Где хранится история сообщений приёмника (pg Drizzle vs файловый harness) — влияет на fork-копирование и revert-plan запросы.
- SSE-типы для fork/revert событий — расширять SessionStreamFrame data как unknown record или вводить narrowed-фреймы.

## Next Epoch Focus
- Decision foundation: зафиксировать разбивку по слоям, контрактные имена, границы jail/логов, что НЕ портируем.
