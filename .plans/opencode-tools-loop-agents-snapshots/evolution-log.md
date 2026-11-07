# evolution-log

- Epoch 1: coarse hypothesis — 7 capabilities, Effect/Hono не переносим, опора overview + существующий harness/agents/contracts/frontend-guard.
- Epoch 2: evidence — donor tool/plugin×19, loop.ts (pendingCalls/nextRequest/stepMessages/collect/addUsage), tool-runtime dispatch/runTools, runner/*, agent registry, snapshot.ts 248, revert.ts 112, session.fork, protocol session group (fork/revert endpoints), receiver sessions.service 102 / controller 208 / harness / agents / executor / contracts sessions / useChat SSE.
- Epoch 3: decisions — tools→новый ai/modules/tools/, runner→внутри sessions, agents→расширение, snapshots→sessions/modules (common только при переиспользовании), контракты YAML-first, не портируем server/TUI/SDK/plugins/PTY/MCP-browser/codegen.
- Epoch 4: refinement — MVP tool-сет 8, fork through/before без blob, revert-plan через Drizzle pg, snapshot git-only best-effort capture/строгий restore; конкретные файлы и проверки зафиксированы в PLAN.md.
