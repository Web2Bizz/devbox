# Epoch 4: Refinement

## Hypothesis
План доводится до конкретных файлов и контрактов; неопределённости закрыты дефолтами.

## Evidence Found
- File: `apps/backend/src/processes/modules/ai/modules/sessions/sessions.controller.ts` — точка добавления `POST /sessions/:id/fork`, `POST /sessions/:id/revert/stage`, `DELETE /sessions/:id/revert`, `POST /sessions/:id/revert/commit`, `GET /sessions/:id/snapshots/diff`.
- File: `packages/contracts/src/sessions/index.ts` — баррель для реэкспорта новых схем.
- File: `contracts/openapi.yaml` — править `components/schemas` + paths `/api/v1/sessions*` синхронно.
- File: `apps/frontend/src/api/sessions-client.ts`, `src/hooks/query-keys.ts`, `src/hooks/useChat.ts`, `src/components/chat/` — точки fork/revert UI.

## Decisions
- Decision: fork копирует сообщения до boundary включительно (through) либо строго до (before), без media-blob в MVP (текст+tool-история; бинарные вложения — вторая очередь).
- Alternatives considered: копировать всё с blob — rejected (нет blob-хранилища в контракте MVP).
- Rationale: текстовый fork закрывает revert-messages сценарий, бинарка не блокирует.
- Decision: revert-plan = запросы к session-history (seq>boundary, assistant, snapshot.start) — как в доноре, но SQL через Drizzle pg вместо sqlite.
- Decision: snapshot MVP = git worktree под REPOS_ROOT (`git rev-parse` discover; не-git → capture=undefined, restore=ошибка `EXTERNAL_UNAVAILABLE`-маппинг); pack-оптимизация и 2МБ-untracked-лимит — вторая очередь.

## Confirmed Plan Items
1. YAML-контракты → zod-схемы → баррели — reason, artifact: contracts, validation: lint+test пакета.
2. ToolRegistry/Dispatch + 8 инструментов (read/write/edit/glob/grep/shell/patch/todo) поверх WorkspacePathService — reason, artifact: backend ai/modules/tools/, validation: spec jail/unknown/invalid.
3. Loop-чистые функции (pendingCalls/nextRequest/stepMessages/collect/addUsage) + runner (step/max-steps/retry/prompt) в sessions harness — reason, artifact: backend, validation: unit fold + e2e interrupt.
4. Agents registry (resolve/select/list, default build, hidden/subagent фильтр) + subagent-job инкапсуляция — reason, artifact: modules/agents/, validation: security spec.
5. Snapshots (capture/diff/restore) + revert stage/clear/commit + fork — reason, artifact: sessions+harness+controller, validation: e2e.
6. Frontend: sessions-client методы + хуки (React Query, ключи в query-keys.ts) + fork-кнопка + revert-диалог с diff + tools-таймлайн в chat-message — reason, artifact: frontend, validation: lint/build + guard.
7. Сквозные проверки: `bun run lint`, `build`, `test`, точечные e2e (sessions/auth), scan секретов в логах — reason, artifact: repo, validation: зелёный прогон.

## Open Questions
- Нет открытых — детали API фиксируются в PLAN.md, расхождения YAML↔пакет считаются багом пакета.

## Next Epoch Focus
- Валидация плана против scope-правил и запись финального PLAN.md.
