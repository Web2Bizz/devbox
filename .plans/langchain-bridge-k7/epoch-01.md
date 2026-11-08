# Epoch 1: Coarse hypothesis — LangChain ядро, OpenCode провайдер

## Hypothesis
- Целевое состояние: основной фреймворк управления агентами — LangChain/LangGraph (JS), OpenCode — один из провайдеров/исполнителей, не ядро.
- Текущее состояние (предположения до проверки): в backend есть два параллельных контура — `ai/modules/*` (agents/tools/opencode-host/sessions) и `workers/*` (run-engine: ModelGateway/Executor/ToolRegistry/McpClient/StubModelGateway). OpenCode доступен как embedded host (`@opencode/sdk@2.2.5`, `OpencodeHostService`) и как внешний serve `:4096`.
- Грубая последовательность: LangChain-слой → OpenCode-провайдер за ModelGateway → инструменты/MCP → LangSmith → отключение legacy-путей.
- Ограничения приняты как аксиомы из prior research: serve не OpenAI-совместим; прокси `KochC/opencode-llm-proxy v1.11.2` под v2 — приоритет LC→OC; облако `openai/v1` только paid/Go; модели только `tools:true` paid/Go.

## Evidence Found
- Пока только входной базис пользователя + канон репо (`AGENTS.md`, `ARCHITECTURE.md`, `CODE_OF_CONDUCT.md`); кодовая проверка — в Epoch 2.
- Prior артефакты к синтезу: `docs/opencode-embedded-spike.md`, `docs/adr/0001-cloud-agent-harness.md`, `docs/adr/0002-agent-harness-prototype.md`, `.plans/opencode-sdk-migration/PLAN.md`, `.plans/amber-phoenix-qt7/PLAN.md`.

## Decisions
- Decision: формат — ДОКУМЕНТ (разделы 1–4 по ТЗ), Trello-карточки не создавать (board `Web2Bizz/rush-code` только инфо).
- Decision: Forward-Only соблюдаем — `baseCommit 0300575`, ветка `feat/chat-commit-cur`; файлы плана не трогают код.
- Alternatives considered: Trello-decompose (`evol-plan`) — rejected по явному выбору пользователя.
- Rationale: нужен архитектурный документ для решения, а не очередь задач.

## Confirmed Plan Items
1. Целевая архитектура (LangChain ядро + OpenCode провайдер через прокси `:4010` как единственный прод-путь + MCP общий + LangSmith; serve Tool fallback и `MODEL_GATEWAY=stub`-фолбэк УДАЛЕНЫ решением Epoch 6, отказ — честный 503) — reason: фиксирует границу ядра/провайдера; artifact: раздел 1 PLAN.md; validation: ревью против ADR-0001/0002.
2. Этапы миграции с порядком и зависимостями — reason: безопасный переход без отката истории; artifact: раздел 2; validation: DAG без циклов.
3. Матрица LC↔OC + ограничения — reason: исключить неверные стыки (serve как OpenAI, free-модели); artifact: раздел 3; validation: таблица решение/когда/лимит.
4. Риски и проверки (E2E bind_tools, регресс, CoC) — reason: приёмка; artifact: раздел 4; validation: чек-листы.

## Open Questions
- Точные пути стыков ToolDomain/MCP/serve-SDK в текущем дереве (Epoch 2).
- Версии `langchainjs`/`langgraphjs` в registry backend и конфликты с `zod ^4.6.5` / `bun 1.4.2` (Epoch 2).
- Статус прокси `:4010` в compose/стенде — есть ли уже или только план (Epoch 2).
- Точный список `tools:true` моделей и где он хранится (код/serve `/v1/models`) (Epoch 2).

## Next Epoch Focus
- Evidence gathering: `tree` + `grep` по `tools/`, `workers/`, `opencode/`, `contracts/`; зафиксировать файлы-стыки, версии, serve-контракт, `.opencode/tools/*.ts`.

## Terminology (Epoch 8 — глоссарий session/harness/runner; историю не переписывает)

- Читать этот эпох по `PLAN.md §0` (`epoch-08.md`): `session` — только чат, `harness` — только система, `runner` — только экземпляр цикла; `freeze/stop/kill/run` — только определение управления runner, не скоуп. Кодовые имена без переименования.

## Superseded (Epoch 7 — in-place, без нового модуля)

- Новодоменная гипотеза («LangChain-слой», «ModelGateway → LC-граф», `workers/modules/langchain/`) — ОТМЕНЕНА Epoch 7: LangChain — библиотека внутри `SessionHarnessService` step-executor → `SessionTurnRunnerService.runTurn` → `ToolDispatchService.dispatch`, нового домена нет.
- П.1 в части `MODEL_GATEWAY`-фолбэка — уже superseded Epoch 6; в части нового gateway-пути — superseded Epoch 7 (переключатель не вводится).
- Актуальное состояние — см. `PLAN.md` (in-place) и `epoch-07.md`.

## Config-isolation (Epoch 9 — harness игнорирует opencode-конфиги; историю не переписывает)

- Читать этот эпох с инвариантом `epoch-09.md` (норматив — `PLAN.md` шапка + §§1/5): новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель: `.opencode/opencode.json`; иные — `[???]`, список не зафиксирован) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути (решение Epoch 9, поведение ранее не задано). LangChain-ядро / `:4010` / 503 / in-place / запреты Epoch 6–7 и глоссарий Epoch 8 — без изменений.
