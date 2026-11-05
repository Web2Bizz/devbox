# Epoch 0: Контракт инструментов AgentTool + реестр/allowlist

## Hypothesis
Сейчас у SessionRunnerService нет параметра tools, агенты — чистые текстовые промптеры. Чтобы граф мог вызывать не только LLM-узлы, но и детерминированные инструменты, нужен единый контракт `AgentTool` (имя, zod-схема входа/выхода, side-effect класс, требование approve) + реестр с allowlist. Это фундамент всех следующих эпох: без него ветвления нечем выполнять.

## Evidence Found
- File: `apps/backend/src/common/zen/session-runner.service.ts` — `chat(userId, prompt, opts: ZenChatOptions)`; `opts` = {model, correlationId, system, onDelta}; параметра tools НЕТ. Транспорт: ExternalClient POST stream:true → fallback plain POST, EXTERNAL_* envelope, AppLogger однострочники.
- File: `apps/backend/src/processes/modules/ai/modules/agents/ask.agent.ts` — прямой `runner.chat`, fallback по ASK_FALLBACK_MODELS, fail-fast на key-ошибки.
- File: `apps/backend/src/processes/modules/ai/modules/agents/auto.agent.ts` — Jev-классификация → линейная цепочка decompose→≤5 шагов→synthesize; исполнители Backend/Frontend/FullstackAgent — тоже только `runner.chat`.
- File: `apps/backend/src/common/zen/jev.service.ts` — платный SystemOne choice-роутер (jev-1.13), не chat-модель.
- Pattern: Zod на границе (DTO), AppLogger без секретов, EXTERNAL_* через ApiErrorFilter, C4-гейт `assertProjectAccessById` перед любым действием.

## Decisions
- Decision: ввести `AgentTool` как интерфейс в processes-слое (`processes/modules/ai/modules/tools/`), а не в common/ — common не знает о доменах (scope-правило AGENTS.md).
- Alternatives considered: (а) tools прямо в SessionRunnerService как OpenAI function-calling — отвергнуто: endpoint ZEN_CHAT_URL не гарантирует function-call поддержку, у нас свой model-fallback и per-user ключи; (б) MCP-тулы сразу — отвергнуто: сначала локальный контракт, MCP — адаптер позже.
- Rationale: инструмент = обычная TS-функция с zod-схемами + декларацией риска; LLM решает ЧТО вызвать, код решает МОЖНО ЛИ (allowlist+jail).

## Confirmed Plan Items
1. Определить тип `AgentTool { name, description, inputSchema: ZodSchema, outputSchema: ZodSchema, sideEffect: 'read'|'write'|'external', requiresApprove: boolean, handler: (input, ctx) => Promise<unknown> }` — причина: единый контракт для LLM-узлов и детерминированных узлов; артефакт: `tools/agent-tool.types.ts`; валидация: lint+юнит на типовую совместимость.
2. Создать `ToolRegistry` (NestJS provider): `register(tool)`, `get(name)`, `listAllowed(ctx)` — причина: allowlist per-project/per-user, jail-гейт; артефакт: `tools/tool-registry.service.ts`; валидация: спек «неизвестное имя → 404, запрещённое → 403».
3. Портировать 2-3 безопасные read-инструмента как первые tools: `project_files_list` (через WorkspacePathService+jail), `history_search` (через SessionHistoryRepository), `jev_classify` (обёртка JevService) — причина: доказать паттерн без мутаций; артефакт: `tools/builtin/*.tool.ts`; валидация: e2e jail (путь вне REPOS_ROOT → отказ).
4. Расширить `SessionRunnerService.chat` опциональным `tools?: AgentToolRef[]` + `toolChoice` БЕЗ ломки сигнатуры (аддитивно, default = без tools = текущее поведение) — причина: LLM-узел сможет вернуть `tool_calls`; артефакт: парсер tool_calls из ответа + цикл «вызов→подстановка результата→повторный chat» с лимитом итераций=3; валидация: юнит «ответ без tool_calls идёт старым путём».
5. Контракт: добавить zod-схемы tools в `@rush-code/contracts` (зеркало openapi.yaml поле-в-поле) — причина: фронт позже покажет шаги инструментов; валидация: контракт-тест.

## Open Questions
- Формат tool_calls: парсить из текста (markdown ```tool ...) или ждать function-calling от endpoint? Нужно проверить, что реально возвращает ZEN_CHAT_URL при system-промпте с описанием tools.
- Где хранить allowlist: в `project_sessions.metadata`, отдельная таблица или конфиг?

## Next Epoch Focus
- Граф-оркестратор: узлы, рёбра-условия, персистентное состояние поверх реестра эпохи 0.
