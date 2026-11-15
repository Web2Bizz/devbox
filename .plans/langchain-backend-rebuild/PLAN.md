Superseded (в части LLM-слоя): см. .plans/langchain-openrouter-migration/PLAN.md (объединённый план)
Superseded: см. .plans/langchain-openrouter-migration/PLAN.md (мульти-провайдер, auto/ask, фолбэк)

# План: миграция backend агентской системы на LangChain/LangGraph + OpenRouter (переделка)

## 0. Статус исходных планов
- langchain-bridge-k7: частично superseded. Отменены запреты «OpenRouter запрещён», «только OpenCode-прокси», «MODEL_GATEWAY запрещён». Сохраняются: без тихих фолбэков, честный 503 EXTERNAL_UNAVAILABLE + Retry-After: 30 + x-correlation-id, журнал run_steps/run_events как истина, intent → confirm для побочных эффектов, config-isolation от opencode-конфигов.
- langchain-openrouter-unified: superseded этим планом.
- langchain-openrouter-migration (PoC для .opencode/workflows): вне scope; workflows/llm.config.json должен использовать тот же конфиг моделей, что и backend.

## 1. Цель состояния
Агентская система backend (apps/backend/src/processes/modules/ai, common/zen, workers/modules/{executor,claim-loop,model-gateway}) работает так:
- Вызовы моделей через LangChain (@langchain/openai поверх OpenRouter).
- Tool-цикл, стриминг, структурированный вывод — стандартные механизмы LangChain/LangGraph, а не самописный цикл.
- Персистентность через журнал run_steps/run_events в Postgres; checkpointer LangGraph — адаптер к этому журналу.
- Внешний контракт API и SSE для фронта сохраняется; изменения только аддитивные (раздел 10).

## 2. Evidence: костыль → замена
- K1 common/zen/session-runner.service.ts (415 стр.): ручной fetch на opencode.ai/inference/openai/v1/chat/completions, ручной SSE, самописный не-стрим fallback → ChatOpenAI (@langchain/openai) с baseURL OpenRouter, model.stream()/streamEvents; fallback не переносим; ретраи через maxRetries с явным лимитом.
- K2 common/zen/jev.service.ts (251 стр.): ручной fetch на systemone, самописный fallback с эвристикой → один вызов withStructuredOutput(zod) на роли classify; эвристика — только если явно описана в контракте. Судьба Jev — открытый вопрос.
- K3 workers/modules/model-gateway/model-gateway.ts (порт ModelGateway.stream: delta/tool_call/done) и model-gateway.stub.ts (подключён в workers.module.ts стр. 44) → реализация порта поверх LangChain (маппинг AIMessageChunk → ModelEvent). Порт сохраняем как узкую границу для runs-claim-loop.service.ts (runLlm, стр. 157; LLM_CALL_FAILED стр. 260).
- K4 workers/modules/executor/executor.ts (ModelGatewayExecutor) и executor.registry.ts (ask и default поверх одного gateway) → исполнитель становится LangGraph-узлом или вызовом агента; регистрация по agentId сохраняется.
- K5 workers/modules/tool-registry/mcp-client.ts (ручной JSON-RPC, fallbackUsed, легаси SSE initialize, стр. 21–139) → @langchain/mcp-adapters (MultiServerMCPClient) или сохранить (открытый вопрос); легаси-фолбэк не переносим.
- K6 processes/modules/ai/modules/sessions/session-harness.service.ts (1581 стр.): probe через relaySse (стр. 1143–1160), EXTERNAL_UNAVAILABLE (стр. 256, 1160) → probe и 503 сохраняем (контракт); вызов LLM — в один LangGraph-граф; session-harness — тонкий фасад.
- K7 common/sse/sse-relay.ts (relaySse, heartbeat 15 с, id:, терминальный stream.error, Last-Event-ID) → не трогаем; меняется только источник событий.
- K8 ai/modules/agents/model-fallback.ts (ASK_FALLBACK_MODELS, isFailFastKeyError) и agents.registry.ts (allowlist tools:true) → один конфиг моделей по ролям и гейт need.toolCalls до вызова; fallback-список удаляем.
- K9 ai/modules/tools/{tool-registry.service.ts, tools.bootstrap.ts, tool-dispatch.service.ts, tool.types.ts} → ToolView → tool() из langchain с zod. ToolDispatchService.dispatch сохраняем (sha, порядок, обработка ошибок).
- K10 ai/modules/agents/modules/subagent/subagent-job.service.ts → субагент как tool() внутри графа, без мутаций сессий.
- K11 ai/modules/opencode/opencode-host.service.ts (embedded @opencode/sdk 2.2.5, package.json стр. 30) → вне LLM-пути; удаление из LLM-пути, решение о пакете — открытый вопрос.
- K12 langchain, @langchain/*, langgraph отсутствуют в package.json backend → добавляем.
Не трогаем: AppLogger и x-correlation-id; common/external/external-error.ts (EXTERNAL_*, 503, Retry-After); session-history.repository.ts и run_*; guardrails (tool-jail.ts); runner/loop.ts, max-steps.ts, retry.ts (бюджеты и политика ретраев шагов — граф их вызывает, не дублирует).
Требует проверки в E0: точные места из evidence (поиск покрыл не все).

## 3. API LangChain JS
Подтверждено: createAgent({model, tools, checkpointer}) из langchain; модель строкой "openrouter:<id>"; agent.streamEvents(input, {version:"v3"}) с stream.messages / stream.toolCalls / stream.output; tool(fn, {name, description, schema: zod}); ChatOpenAI с configuration.baseURL (нестандартные поля ответа провайдера не сохраняются); MemorySaver только для dev/тестов.
Проверить в E0: версия streamEvents v3 в зафиксированном пине (иначе v2 или model.stream()); совместимость withStructuredOutput с tool-calling моделями OpenRouter; поведение maxRetries у ChatOpenAI; нужен ли @langchain/mcp-adapters.
Пакеты — точные версии в package.json и lockfile.

## 4. Архитектурные решения
- A1 Агент/граф: LangGraph (createAgent или StateGraph). Самописный tool-цикл убираем. Обоснование: цикл model→tool_calls→dispatch→model, checkpointing, human-in-the-loop для intent → confirm. Альтернативы (оставить цикл в runner/loop.ts; bindTools вручную) отвергнуты.
- A2 Tool-цикл: граф строится LangGraph; узел инструментов вызывает ToolDispatchService.dispatch.
- A3 Стриминг: LangChain stream/streamEvents; маппинг в SSE-кадры в одном месте (session-harness); relaySse не меняем; ModelEvent остаётся внутренним портом для claim-loop.
- A4 Персистентность и resume: источник истины run_steps/run_events (session-history.repository.ts). Checkpointer — собственный адаптер BaseCheckpointSaver поверх Postgres или состояние в run_steps. MemorySaver — только тесты. Альтернатива @langchain/langgraph-checkpoint-postgres — не по умолчанию (второй журнал рядом с run_*). Resume берёт последний committed, LLM не переисполняется.
- A5 Провайдер и конфиг: один модуль в common/env (zod, fail-closed без ключа) и один файл ролей моделей (llm.config.json или секция конфига, без ключей). OpenRouter — единственный провайдер. OPENCODE_URL для LLM не используется.
- A6 Структурированный вывод: withStructuredOutput(zod). Невалидный ответ → bad_shape, без тихой эвристики (кроме описанной в контракте).
- A7 Ошибки и 503: 429/5xx/таймаут/сеть → EXTERNAL_UNAVAILABLE 503 + Retry-After: 30 через external-error.ts. 400/422 → BAD_REQUEST, 404 → NOT_FOUND. Без фолбэка на другую модель/провайдер. Сообщения без URL, тел, ключей.
- A8 Безопасность: OPENROUTER_API_KEY только из env; редакция в AppLogger; keys.e2e.ts расширить на OPENROUTER_*; LLM видит только ToolView-проекцию и allowlist guardrails.

## 5. Сложность и риск
complexity: score 17, level high, files 14, cards 9 (C0–C8), deps 4 (langchain, @langchain/core, @langchain/openai, @langchain/langgraph; mcp-adapters опц.), type decompose, unknowns 5.
risk: high, score 7/8, factors breaking, data, security, external. Mitigation: golden-baseline до переписывания (C0); контрактные SSE-тесты до и после; переключатель только как этап миграции, удаляется после приёмки (не фолбэк); ключи только из env + e2e-скан; 503 без тихого фолбэка.
Риск external: OpenRouter может исключать провайдеров по ZDR-политике аккаунта (подтверждено ошибкой генерации картинки в этом сеансе) — проверка в E0.

## 6. Карточки
C0. Golden-baseline (до переписывания). Blocked by: —
 - Снять поведение session-runner (chatStream), jev.service, model-gateway.stub и claim-loop: простой ответ, tool_call, 503 (proxy down), 403 free-модель, отмена, таймаут.
 - Зафиксировать SSE-кадры (id:, heartbeat, stream.error, терминальный done{usage}) и коды ошибок в fixtures.
 - Контрактные тесты: sessions-stream.spec.ts, session-harness-*.spec.ts, runs.e2e.ts (SSE) зелёные до изменений.
 - Валидация: зелёные тесты, golden-fixtures воспроизводимы после нормализации runId и ms.
C1. Зависимости и конфиг. Blocked by: C0
 - langchain, @langchain/core, @langchain/openai, @langchain/langgraph — точные версии. Проверить streamEvents v3 в пине (E0).
 - common/env: zod для OPENROUTER_API_KEY, OPENROUTER_BASE_URL (дефолт https://openrouter.ai/api/v1), LANGSMITH_* опц. Без ключа — fail-closed.
 - Файл ролей моделей (роль → модель OpenRouter, только с tool calls). .env.example без значений.
 - Валидация: unit на отсутствие ключа и на валидацию конфига ролей.
C2. LLM-слой (единственный модуль вызова моделей). Blocked by: C1
 - Порт ModelGateway поверх ChatOpenAI; маппинг AIMessageChunk → ModelEvent (delta/tool_call/done с usage).
 - maxRetries с лимитом, таймаут, маппинг ошибок (A7).
 - Заменить stub в workers.module.ts (стр. 44); StubModelGateway удалить после C6.
 - Валидация: unit с мок-сервером (успех, 429, 5xx, таймаут, битый JSON); e2e bind_tools → tool_calls → ToolDispatchService.dispatch на одной tools-модели.
C3. Инструменты как LangChain tools. Blocked by: C2
 - tools.bootstrap.ts и tool-registry.service.ts: ToolView → tool() с zod.
 - ToolDispatchService.dispatch без изменения логики.
 - Субагент как tool() без мутаций сессий.
 - MCP: решить mcp-adapters или mcp-client.ts (E0). Легаси-фолбэк удалить или оставить одним исключением с комментарием.
 - Валидация: git.recon + 1 custom + 1 MCP-инструмент через граф end-to-end.
C4. Граф выполнения агента. Blocked by: C2, C3
 - Граф (createAgent или StateGraph): узлы модель и инструменты, условие продолжения. Лимит шагов через max-steps.ts.
 - ModelGatewayExecutor и executor.registry.ts → вызов графа по agentId.
 - runner/loop.ts — политика бюджетов; цикл не дублировать.
 - Валидация: unit на переходы (tool → model → end), лимит шагов, ошибка инструмента.
C5. Персистентность, resume, checkpointer. Blocked by: C4
 - Адаптер checkpointer поверх run_steps/run_events (A4). MemorySaver — только тесты.
 - Resume берёт последний committed; LLM не переисполняется.
 - Валидация: restart mid-run → без повтора tool.call и git.commit; run_steps UNIQUE(runId, seq) и run_effects intent → committed выполняются.
C6. Переключение прод-пути и SSE-контракт. Blocked by: C0, C4, C5
 - session-harness вызывает граф; маппинг в существующие SSE-кадры. relaySse и probe 503 сохраняем.
 - jev.service.ts и session-runner.service.ts — удалить или legacy вне пути (открытый вопрос).
 - Валидация: все C0-контрактные тесты зелёные; SSE-кадры совпадают с golden; e2e 503 при недоступном OpenRouter.
C7. Безопасность и наблюдаемость. Blocked by: C2
 - Редакция ключей в AppLogger; keys.e2e.ts на OPENROUTER_* и LANGSMITH_*.
 - Однострочные логи без URL, тел и Bearer. LangSmith опц., с x-correlation-id.
 - Валидация: e2e-скан секретов, lint, build.
C8. Документация и приёмка. Blocked by: C6, C7
 - ARCHITECTURE.md, .env.example, contracts/openapi.yaml; superseded-решения в .plans/langchain-bridge-k7/PLAN.md.
 - Валидация: bun run lint, build, test, test:e2e.

## 7. Эпохи
E1 (C0) цель, evidence, golden. E2 (C1, C2) LLM-слой, 503. E3 (C3, C4) инструменты и граф. E4 (C5, C6) состояние и контракт. E5 (C7, C8) приёмка.

## 8. Checkpoints
CP0 golden и SSE-тесты зелёные до изменений (после C0). CP1 ChatOpenAI→OpenRouter проходит unit и e2e bind_tools (после C2). CP2 граф проходит golden, resume без повтора эффектов (после C5). CP3 SSE без breaking, 503 на отказ OpenRouter, скан секретов чист (после C7). CP4 перед удалением StubModelGateway, jev.service.ts, session-runner.service.ts — отдельное решение пользователя.

## 9. Acceptance
- Чат и claim-loop работают через OpenRouter; LLM-вызовы через LangChain; самописного fetch и ручного SSE-парсинга в LLM-пути нет.
- Tool-цикл — LangGraph; ToolDispatchService исполняет инструменты; guardrails и tool-jail работают.
- Ошибка провайдера — EXTERNAL_UNAVAILABLE 503 с Retry-After: 30 и x-correlation-id; тихого фолбэка нет.
- Resume без повтора LLM и побочных эффектов (intent → confirm).
- Смена модели по роли — правкой конфига.
- Ключи не попадают в логи и артефакты. lint, build, test, test:e2e зелёные.
- API/SSE — только аддитивные изменения.

## 10. Изменения контракта API/SSE
- Опциональные поля в tool.call / tool.result: toolCallId, agentId.
- done получает опциональный usage (из LangChain usage_metadata).
- Ошибка провайдера остаётся EXTERNAL_UNAVAILABLE 503 + Retry-After: 30; формат не меняется.
- Новых эндпоинтов нет. openapi.yaml и packages/contracts — зеркально, только optional.
- Breaking (например, удалить ModelEvent-кадры) — отдельное решение с фронтом.

## 11. Открытые вопросы
1. ZDR/privacy-настройки OpenRouter: доступны ли нужные чат-модели при текущем аккаунте.
2. streamEvents v3 в пине — есть ли; иначе какой стрим-API.
3. Checkpointer: свой адаптер поверх run_* (рекомендовано) или @langchain/langgraph-checkpoint-postgres.
4. jev.service.ts: withStructuredOutput на роли classify или legacy.
5. session-runner.service.ts и opencode-host.service.ts (@opencode/sdk 2.2.5): удалить после C6 или оставить.
6. Список моделей с tool calls и цены по ролям (allowlist конфига).
7. MCP: @langchain/mcp-adapters или текущий mcp-client.ts.
8. Инвентаризация opencode-конфигов (из k7 epoch-09) не проведена.
9. Workflows в .opencode — вне scope, отдельный план; общий конфиг моделей из C1 использовать.
