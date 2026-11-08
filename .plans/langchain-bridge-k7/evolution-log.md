# Evolution log — langchain-bridge-k7

## Epoch 1 (Coarse hypothesis)
- Принято: формат ДОКУМЕНТ, без Trello; Forward-Only `0300575` / `feat/chat-commit-cur`.
- Гипотеза: два контура (`ai/modules/*`, `workers/*`), LC-ядро + OC-провайдер.

## Epoch 2 (Evidence gathering)
- Подтверждено кодом: `tools/` (8 tools, `tool.types.ts`), `agents/` + `subagent-job.service.ts`, `opencode-host.service.ts` (SDK 2.2.5), `workers/model-gateway.ts` + `stub.ts`, `executor.ts`, `tool-registry.ts` + `mcp-client.ts`, `.opencode/tools/*.ts` (22), `package.json` (без langchain — новые deps), `docker-compose.yml` (без :4096/:4010).
- Зафиксированы external-допущения (serve wire, прокси v1.11.2, 403 free, tools:true allowlist) как проверяемые на пилоте.

## Epoch 3 (Decision foundation)
- Решено: V1 прокси primary, V2 serve Tool fallback, V3 CLI tertiary; V4 custom-tools→сервис; V5 sidecar MCP; V6 LangSmith поверх AppLogger.
- Отклонено: serve как `BaseChatModel`, только-serve без bind_tools, OpenCode-ядро.
- Superseded (частично): `.plans/opencode-sdk-migration/PLAN.md` «только embedded, удалить HTTP» — embedded остаётся фолбэком, HTTP-контракт жив до Э5.

## Epoch 4 (Refinement)
- Новый домен `workers/modules/langchain/` (CoC), прокси — compose sidecar, `MODEL_GATEWAY` переключатель, stub жив до Э5, `MemorySaver` только dev.

## Epoch 5 (Validation)
- Скоринг: complexity 14/20 medium-high; risk 5/8 medium [breaking,data,security,external].
- Приёмка: 6 чек-листов (§4). Открытых вопросов не осталось — unknowns ушли в задачи Э0.

## Epoch 6 (Fallback-ban — честный 503)
- Запрет: serve Tool fallback-ветка, переход на stub при proxy down, выбор по `need.toolCalls` + health, откат `MODEL_GATEWAY=stub` — УДАЛЕНЫ из PLAN.md §§1–5 и помечены superseded в epoch-01/03/04/05.
- Новое состояние: прокси `:4010` — единственный прод-путь (V1); при proxy down / host down / 5xx / таймауте — `503 EXTERNAL_UNAVAILABLE` + `Retry-After: 30` + `x-correlation-id`, без retry внутри (retry решает вызывающий).
- Матрица: V1 — единственный путь + 503; V2 serve Tool — только ЗАПРЕТ («НЕ ДЕЛАТЬ», без инструкции); V3 CLI — только офлайн/дебаг, НЕ fallback прод-пути.
- Этапы: `Э0 Пилот → Э1 Gateway (без fallback) → Э2 Tools → Э3 Честный 503 → Э4 Харденинг → (Э5 Чистка)`; Э3 переопределён (health-probe + маппинг + e2e на 503 вместо `opencode-serve.tool.ts`).
- Риски/приёмка: R1 без V2-фолбэка; R2 — free/beelding/proxy down/host down → 503 + `Retry-After: 30` + correlation; приёмка «Отказ вместо фолбэка» (остановленный `:4010` → 503, serve-ветка отсутствует, перехода на stub нет).
- Скоринг пересчитан: complexity 13/20 medium (files 10–12, deps 5, unknowns 2, type update); risk 5/8 medium [breaking,data,security,external] (mitigation — честный 503).

## Epoch 7 (In-place — без нового модуля; новодоменные формулировки Epoch 1–6 отменены)

- Запрет: новый домен `workers/modules/langchain/` (`langchain.module.ts`, `langchain-gateway.service.ts`, `opencode-proxy.model.ts`, `lc-tools.adapter.ts`, `lc-tracing.setup.ts`) — НЕ СОЗДАВАТЬ; `MODEL_GATEWAY=stub|langchain`-переключатель как новый путь/рантайм-фолбэк — НЕ ВВОДИТЬ. Supersedes: Decision Epoch 4 о новом домене; все `workers/modules/langchain` / `LangChainGateway` / `MODEL_GATEWAY`-формулировки Epoch 1–6 и PLAN.md ревизий до Epoch 7.
- Новое состояние: LangChain — библиотека внутри существующих сервисов (`SessionHarnessService` step-executor → `SessionTurnRunnerService.runTurn` → `ToolDispatchService.dispatch`); маппинг tools — внутри `tool-registry.service.ts`/`tools.bootstrap.ts`; LangSmith — обёртка внутри harness; MCP — существующие `mcp-client.ts`/`mcp-tool-source.ts`. Фронт — `sessions-client.ts`/`useChat.ts`/`ChatThread.tsx`/`ChatToolTimeline.tsx` без новых компонентов.
- Сохранено без изменений: LangChain — ядро управления; OpenCode-провайдер через прокси `:4010` — primary и единственный прод-путь; только paid/Go `tools:true`; при недоступности — честный 503 (`EXTERNAL_UNAVAILABLE` + `Retry-After: 30` + `x-correlation-id`); fallback запрещён (Epoch 6 в силе).
- Этапы переписаны in-place: `Э0 Пилот → Э1 Harness-step (без fallback) → Э2 Tools → Э3 Честный 503 → Э4 Харденинг → (Э5 Чистка)`; каждый этап называет только существующие файлы (`sessions/session-harness.*`, `sessions/modules/runner/*`, `agents/*`, `tools/*`, `workers/modules/tool-registry/mcp-client.ts`, `common/sse/sse-relay.ts`, `common/external/external-error.ts`, `api/sessions-client.ts`, `hooks/useChat.ts`, `chat-thread/ChatThread.tsx`, `chat-tool-timeline/ChatToolTimeline.tsx`).
- Матрица V1–V6 переписана без новых модулей: V1 — harness-step + 503; V2 — ЗАПРЕЩЁН; V3 — НЕ fallback; V4 — регистрация через существующий `tools.bootstrap.ts`; V5 — существующий `mcp-client.ts`; V6 — обёртка внутри harness.
- Риски/приёмка: R1–R6 привязаны к существующим файлам; приёмка — E2E bind_tools in-place, отказ 503 (фронт — существующий `ErrorState`), регресс журнала/SSE, CoC/lint, additive-контракты.
- Скоринг пересчитан: complexity 14/20 medium-high (файлов к правке 15–18 существующих, deps 5, unknowns 2, type update; +1 к Epoch 6 за регресс живого пути); risk 6/8 medium-high [breaking,data,security,external] (было 5/8 medium; +1 за breaking-поверхность живого пути harness 1581 + useChat 1101 + SSE; mitigation — честный 503 + e2e регресс).

## Epoch 8 (Terminology-fix — session/harness/runner; только документ, код/карточки — ноль)

- Глоссарий: `PLAN.md §0` нормативен — `session` только чат пользователя с ИИ; `harness` только агентская система (агенты, инструменты, MCP, инструкции; LC step-executor + probe + 503); `runner` только процесс harness, экземпляр цикла/обёртка (`SessionTurnRunnerService.runTurn` + `loop/max-steps/retry`); `freeze/stop/kill/run` только определение управления runner, НЕ новый скоуп работ. Кодовые имена (`SessionHarnessService`, `SessionTurnRunnerService`, `session-*`) НЕ переименовываются — только маппинг «термин → носитель».
- Смешения до Epoch 8 (`harness` как процесс, `runner` как система, `session` как состояние/хранилище) — читать по глоссарию §0; смысловые решения Epoch 6 (fallback-запрет, честный 503) и Epoch 7 (in-place, без нового модуля) ПОДТВЕРЖДЕНЫ без изменений. Новых сущностей нет; AGENTS/docs — только ссылки в §0, правок ноль.
- Скоринг правки: complexity 2/20 low (9 `.md`, deps 0, unknowns 0, type docs); risk 1/8 low [docs]. Скоринг плана Epoch 7 неизменен: complexity 14/20 medium-high, risk 6/8 medium-high [breaking,data,security,external].

## Epoch 9 (Config-isolation — harness игнорирует opencode-конфиги; только документ, код/карточки — ноль)

- Инвариант: новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель `.opencode/opencode.json`; иные — `[???]`, точный список не зафиксирован, не выдумывать) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути. Поведение ранее не задано → зафиксировано как решение Epoch 9.
- Сохранено без изменений: LangChain — ядро управления; прокси `:4010` — единственный прод-путь; честный 503; in-place без `workers/modules/langchain/`; запреты Epoch 6–7; глоссарий Epoch 8 (`session` — чат, `harness` — система, `runner` — процесс/экземпляр цикла).
- Артефакты: `PLAN.md` (шапка инвариант + §1 bullet + §5 запрет-список, эпохи `epoch-01..09.md`), новый `epoch-09.md`, указатели Config-isolation в `epoch-01..08.md`.
- Скоринг правки: complexity 2/20 low (11 `.md`, deps 0, unknowns 0, type docs); risk 1/8 low [docs]. Скоринг плана Epoch 7 неизменен: complexity 14/20 medium-high, risk 6/8 medium-high [breaking,data,security,external].
