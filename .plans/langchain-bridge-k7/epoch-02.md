# Epoch 2: Evidence gathering — стыки, serve, инструменты, версии

## Hypothesis
Epoch 1 предположил два контура (`ai/modules/*` и `workers/*`). Проверяем их наличие и точные пути стыков.

## Evidence Found
- File: `apps/backend/src/processes/modules/ai/modules/tools/` — `tool.types.ts` (ToolContext/ToolDefinition/ToolHandler/ToolCall/ToolSettlement), `tool-registry.service.ts`, `tool-dispatch.service.ts`, `tools.bootstrap.ts`, 8 tools (`read/write/edit/glob/grep/patch/shell/todo`).
- File: `apps/backend/src/processes/modules/ai/modules/agents/` — `agent.base.ts` (zod-схемы, `agentIdPattern/modelNamePattern`), `agents.registry.ts`, `agents.service.ts`, `ask/auto/backend/frontend/fullstack.agent.ts`, `modules/subagent/subagent-job.service.ts` (subagent как ToolSettlement, без исключений наружу).
- File: `apps/backend/src/processes/modules/ai/modules/opencode/opencode-host.service.ts` — embedded `@opencode/sdk@2.2.5` singleton, `getHost()/isUp()/onModuleDestroy`, consumers пока на старом пути (spike-документ).
- File: `apps/backend/src/processes/modules/workers/modules/model-gateway/model-gateway.ts` — `ModelGateway.stream(req: ModelRequest): AsyncIterable<ModelEvent>` (delta/tool_call/done+usage), tools только как `ToolView`-проекция (D3 ADR-0002). `model-gateway.stub.ts` — единственный провайдер прототипа (stub-turn).
- File: `apps/backend/src/processes/modules/workers/modules/executor/executor.ts` — `Executor{id, stream}`, `ModelGatewayExecutor` (gateway за agent id).
- File: `apps/backend/src/processes/modules/workers/modules/tool-registry/tool-registry.ts` + `mcp-client.ts` — `ToolRegistry` (register/listViews/invoke с sha256 request/response), `McpClient` stateless streamable-HTTP + один `initialize`-фолбэк, `listTools/callTool` наружу; своего MCP-сервера нет (D5 ADR-0002).
- File: `apps/backend/src/processes/modules/workers/modules/tool-registry/tools/git-recon.tool.ts` — единственный нативный tool engine-контура.
- File: `.opencode/tools/*.ts` (22 файла: `boards/check/classify_*/commit_trello/git_changes/graphify/lists/planner/postgres/task_*/tunnel/workflow/worktree`) — паттерн custom tools: `export default {description, input{type:object...}, async execute(input, context)}`, резолв через `_resolve.ts` + `Bun.spawn(["bash", script])`.
- File: `apps/backend/package.json` — `@opencode/sdk 2.2.5`, `zod ^4.6.5`; `langchain/@langchain/*/@mcp/*` отсутствуют в deps (миграция = новые зависимости, проверить `zod v4` совместимость адаптеров).
- File: `docker-compose.yml` — только backend+frontend, Postgres external; opencode-runner `:4096` и прокси `:4010` в текущем compose отсутствуют (стенд-дельта).
- Pattern: CoC backend — `<domain>/{module,controller,service,dto,repository,config,types}.ts` + `modules/<sub>/` + `__tests__/`, `AppLogger` only, fail-fast без тихих фолбэков, C4-gate 404 без утечки, зеркало `contracts/openapi.yaml` ↔ `packages/contracts`.
- Confirmed external (из базиса, кодом не перепроверялось — фиксируется как допущение с проверкой на пилоте): serve `:4096` свой OpenAPI (`/session/:id/message`, `/event`, `/doc`) не OpenAI-совместим; прокси `KochC/opencode-llm-proxy v1.11.2` под v2 (`:4010`, `/v1/chat/completions`, `/v1/models`, SSE, `tool_calls: true`); облако `openai/v1` free → 403 вне OpenCode; allowance только `tools:true` paid/Go (claude-sonnet/opus/haiku-5/4, gpt-6.1/6/5.5/5.4, gemini-4/3.x, kimi-k2.7, minimax-m3, glm-5.x, qwen, deepseek; jev/free/image/embedding — исключить).

## Decisions
- Decision: LangChain — ядро (`workers/` engine), OpenCode — провайдер за `ModelGateway`, не параллельное ядро.
- Alternatives considered: OpenCode-ядро + LangChain-адаптер сверху — rejected (противоречит ТЗ и ADR-0001 выводу «SDK — исполнители, не ядро»).
- Rationale: `ModelGateway.stream` уже есть как узкая граница; замена stub на LC-граф + OC-провайдер не ломает claim-loop/журнал.

## Confirmed Plan Items
1. Стык `ModelGateway` — единственная граница провайдера — reason: claim-loop видит только `ModelEvent`; artifact: `model-gateway.ts`; validation: новый `LangChainGateway extends ModelGateway` без изменения `Executor`.
2. Стык `ToolRegistry.listViews/invoke` — модель видит только проекцию — reason: D3 уже держится конструкцией; artifact: `tool-registry.ts`; validation: маппинг `ToolView → DynamicStructuredTool` без проброса handler/policy.
3. Стык `McpClient` — общий MCP для LC и OC — reason: sidecar без своего сервера; artifact: `mcp-client.ts`; validation: `MultiServerMCPClient`-совместимый URL-каталог.
4. Стык `SubagentJobService.run → ToolSettlement` — reason: subagent уже инкапсулирован как tool-результат; artifact: `subagent-job.service.ts`; validation: обёртка как LC Tool без мутаций сессий.
5. Стык `.opencode/tools/*.ts → LangChain-сервис` — reason: 22 готовых custom tools — reuse, не рерайт; artifact: `execute(input, context)` → HTTP/сервис; validation: контракт input-schema сохранён.

## Open Questions
- Точный wire-контракт serve (`contracts/opencode-stand-2.2.0.json`, `contracts/opencode-upstream.json`) vs прокси `/v1/*` — сверить поля `tool_calls` на пилоте (Epoch 3).
- Где хранить allowlist `tools:true` моделей — env/config vs fetch `/v1/models` с фильтром (Epoch 3).
- `langsmith-opencode` трейсинг: отдельный пакет или env-переменные `LANGSMITH_*` + обёртка (Epoch 3).

## Next Epoch Focus
- Decision foundation: выбрать primary/фолбэк варианты LC↔OC, зафиксировать конфликты (serve vs прокси, session state, 403 free, tools:true).

## Superseded (Epoch 7 — in-place, без нового модуля)

- П.2 «новый `LangChainGateway extends ModelGateway`» и validation «без изменения `Executor`» — ОТМЕНЕНЫ Epoch 7: новый gateway-файл не создаётся, LC живёт в `SessionHarnessService` step-executor; граница `ModelGateway.stream`/`Executor` не перестраивается.
- Остальные стыки (п.1, п.3–п.5) действуют в in-place трактовке: `ToolRegistry.listViews/resolve` + `ToolDispatchService.dispatch` — исполнение без изменений, маппинг — строки внутри `tool-registry.service.ts`/`tools.bootstrap.ts`; MCP — существующие `mcp-client.ts`/`mcp-tool-source.ts`.
- Актуальное состояние — см. `PLAN.md` (in-place) и `epoch-07.md`.

## Terminology (Epoch 8 — глоссарий session/harness/runner; историю не переписывает)

- Читать этот эпох по `PLAN.md §0` (`epoch-08.md`): `session` — только чат, `harness` — только система (`SessionHarnessService`), `runner` — только экземпляр цикла (`SessionTurnRunnerService` + `loop/max-steps/retry`); `freeze/stop/kill/run` — только определение управления runner, не скоуп. Кодовые имена без переименования.

## Config-isolation (Epoch 9 — harness игнорирует opencode-конфиги; историю не переписывает)

- Читать этот эпох с инвариантом `epoch-09.md` (норматив — `PLAN.md` шапка + §§1/5): новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель: `.opencode/opencode.json`; иные — `[???]`, список не зафиксирован) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути (решение Epoch 9, поведение ранее не задано). LangChain-ядро / `:4010` / 503 / in-place / запреты Epoch 6–7 и глоссарий Epoch 8 — без изменений.
