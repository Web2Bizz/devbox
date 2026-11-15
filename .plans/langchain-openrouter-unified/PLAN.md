Superseded (в части LLM-слоя): см. .plans/langchain-openrouter-migration/PLAN.md (объединённый план)
Superseded: см. .plans/langchain-backend-rebuild/PLAN.md (переделка на нормальном LangChain/LangGraph)

# Объединённый план: LangChain + OpenRouter (apps/backend + агентская система)

## Решение
Объединяем два направления в один план (выбор пользователя):
- apps/backend: переезд LLM-слоя на LangChain + OpenRouter (вместо прямого OpenCode-прокси).
- .opencode (workflows/, engine.ts, classify_build.ts): см. `.plans/langchain-openrouter-migration/PLAN.md`, карточки C1–C10 там остаются в силе и подчиняются общим решениям ниже.
- `.plans/langchain-bridge-k7/` помечается как частично superseded: запреты «OpenRouter-путь запрещён», «единственный провайдер OpenCode-прокси», «fallback запрещён», «MODEL_GATEWAY запрещён» отменяются этим решением (OpenRouter становится единственным провайдером). Остальные решения k7 (не создавать лишних модулей сверх необходимого, контракты, не ломать SSE-протокол) продолжают действовать.

## Общие решения
- LangChain: оркестратор LLM-вызовов и tool-цикла; ChatOpenAI с baseURL https://openrouter.ai/api/v1.
- OpenRouter: единственный провайдер моделей; модели по ролям в одном конфиге (не в коде).
- Ключи только из env (OPENROUTER_API_KEY; OPENCODE_API_KEY/JEV_API_KEY — только пока нужны legacy-пути). В репо — только .env.example без значений. Редакция ключей в логах и audit.
- Откат: флаг ENGINE=legacy|lc для workflows; для backend — переключатель на время миграции, удаляется после приёмки.
- Модели для tool-цикла: только с поддержкой tool calls (проверить по каталогу OpenRouter).

## Evidence apps/backend
- apps/backend/src/common/zen/session-runner.service.ts (415 стр.): прямой fetch на https://opencode.ai/inference/openai/v1/chat/completions, SSE-парсинг, chatStream + не-стрим fallback. Главный LLM-транспорт.
- apps/backend/src/common/zen/jev.service.ts: тот же endpoint, сервис Jev.
- apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts (1581 стр.): оркестратор чата, probe + EXTERNAL_UNAVAILABLE.
- apps/backend/src/processes/modules/ai/modules/opencode/opencode-host.service.ts: embedded @opencode/sdk.
- apps/backend/src/processes/modules/workers/modules/model-gateway/ (model-gateway.ts, model-gateway.stub.ts): порт ModelGateway.stream, сейчас stub — точка подключения адаптера.
- workers/modules/executor/executor.registry.ts, workers/modules/claim-loop/runs-claim-loop.service.ts (runLlm, LLM_CALL_FAILED).
- ai/modules/agents/model-fallback.ts: ASK_FALLBACK_MODELS.
- В backend нет langchain/openai/openrouter в зависимостях.
Объём: 4–5 модулей, 10–14 файлов, 2–3 новых зависимости.

## Сложность и риск (backend)
complexity: score 15, level high, files 12, cards 7 (backend) + 10 (агенты), deps 3, type update, unknowns 4.
risk: high, 6/8, factors breaking, data, security, external.

## Карточки backend (B)
B0. Golden-baseline текущего LLM-пути. Blocked by: —
  - снять поведение session-runner и model-gateway.stub на кейсах: простой, tool_call, 503, free-модель 403, отмена
  - зафиксировать SSE-кадры и коды ошибок
  - валидация: тесты sessions-stream.spec.ts, session-harness-*.spec.ts зелёные до изменений
B1. Env/конфиг контракт OpenRouter. Blocked by: —
  - OPENROUTER_API_KEY, база URL, .env.example без значений
  - карта модель по роли и need.toolCalls в model-fallback.ts
  - fail-closed без ключа с понятным сообщением
  - валидация: zod при старте; unit на отсутствие ключа
B2. Адаптер LLM через ModelGateway. Blocked by: B1
  - реализация ModelGateway.stream поверх ChatOpenAI, bind_tools из ToolView
  - маппинг ModelEvent (delta / tool_call / done+usage), таймаут, лимит retry
  - 429/5xx/таймаут → EXTERNAL_UNAVAILABLE 503 + Retry-After: 30 (common/external/external-error.ts)
  - валидация: unit на мок-сервере; e2e bind_tools → tool_calls → ToolDispatchService.dispatch
B3. Переключение прод-пути за одним местом. Blocked by: B0, B2
  - подключить адаптер в session-harness.service.ts и runs-claim-loop через ModelGateway
  - решить судьбу session-runner и jev.service: замена или legacy вне пути
  - валидация: регресс B0-кейсов; lint/test/build зелёные
B4. Безопасность и логи. Blocked by: B2
  - редакция ключей в AppLogger и audit; расширить keys.e2e.ts на OPENROUTER_*
  - denylist моделей без tools:true для tool-цикла
  - валидация: e2e-скан секретов в логах
B5. Resume и журнал без повтора эффектов. Blocked by: B3
  - прод-память из run_steps/run_events (session-history.repository.ts); LC replay не переисполняет LLM
  - валидация: restart mid-run → без повтора tool.call / git.commit
B6. Контракты и фронт (additive). Blocked by: B3
  - packages/contracts + openapi.yaml — только optional-поля; фронт показывает 503 через ErrorState
  - валидация: lint/build; зеркало контрактов совпадает

## Карточки агентской системы (A)
Берутся из `.plans/langchain-openrouter-migration/PLAN.md`: A1=C1 golden-baseline new-task, A2=C2 конфиг моделей, A3=C3 адаптер (переиспользует общий адаптер из B2 — не дублировать), A4=C4 engine-lc, A5=C5 LLM-шаги, A6=C6 тесты эквивалентности, A7=C7 security, A8=C8 classify_build, A9=C9 раскатка, A10=C10 документация.
Связь: A3 Blocked by B2 (один общий LLM-адаптер для backend и workflows). Общий конфиг моделей — один файл для обоих.

## Эпохи
E1: решение и общий адаптер (B1, B2, A2, A3).
E2: baseline и PoC агентов (B0, A1, A4–A6).
E3: переключение backend и безопасность (B3, B4, A7).
E4: resume, контракты, раскатка (B5, B6, A8–A10).

## Checkpoints
- CP1: общий адаптер B2 и A3 проходят unit и e2e на OpenRouter.
- CP2: B3 — регресс чата и SSE без изменения протокола; A6 — golden-diff зелёный.
- CP3: B4 + A7 — security без high; перед раскаткой A9.

## Acceptance
- Чат и claim-loop работают через OpenRouter; ошибка провайдера — честный 503 без тихого фолбэка.
- new-task --dry-run на golden-кейсах эквивалентен legacy; ENGINE=legacy остаётся откатом.
- Секреты не попадают в логи и artifacts; lint/test/build зелёные.
- Смена модели по роли — правкой конфига без изменения кода.

## Открытые вопросы
- Нужен ли OpenCode-прокси после миграции (сейчас уходит)?
- Список моделей OpenRouter с поддержкой tool calls и цены по ролям.
- Судьба jev.service.ts и session-runner.service.ts: замена или legacy.
- Инвентаризация opencode-конфигов (из k7 epoch-09) не проведена.
