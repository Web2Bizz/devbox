# Epoch 4: Refinement — архитектура по файлам, этапы, CoC-размещение

## Hypothesis
Решения Epoch 3 достаточны, чтобы расписать целевую архитектуру до уровня модулей и этапы до уровня «что включаем/выключаем».

## Evidence Found
- File: `apps/backend/src/processes/modules/workers/workers.module.ts` — точка монтирования `ModelGateway`/`ToolRegistry`/`McpClient` (LC-модули — соседние `modules/langchain/*`, регистрация только там, `AppModule` напрямую не трогаем — CoC).
- File: `apps/backend/src/common/db/schema.ts` — `run_runs/run_steps/run_events/run_effects/run_leases/run_definitions` (журнал — истина, LC-чекпоинтер вторичен; `PostgresSaver`/`MemorySaver` только для dev-e2e, прод — наш журнал).
- File: `packages/contracts/src/` + `contracts/openapi.yaml` — зеркало поле-в-поле; новые LC-поля (model id, trace id) — только additive optional, иначе breaking.
- Pattern: `createAgent({model, tools, checkpointer})` / `StateSchema` / `Command` / `MemorySaver` — канон LangGraph JS для пилота; прод-память — наш журнал, не checkpointer.
- Pattern: `bind_tools` → `tool_calls[]` → `ToolNode` → `Command` — цикл, который проверяет E2E.

## Decisions
- Decision: новый домен `workers/modules/langchain/` (CoC `modules/<sub>/`): `langchain.module.ts`, `langchain-gateway.service.ts` (`extends ModelGateway`), `opencode-proxy.model.ts` (`ChatOpenAI` на `:4010`), `lc-tools.adapter.ts` (`ToolView → DynamicStructuredTool`), `lc-tracing.setup.ts` (LangSmith), `__tests__/` (bind_tools e2e, allowlist spec).
- Decision: прокси — compose sidecar (`opencode-llm-proxy:4010`, back-сеть к backend, env ключи), не в процессе backend. Rationale: v1.11.2 — отдельный бинарь/образ под v2.
- Decision: `StubModelGateway` — НЕ runtime-fallback (переключатель `MODEL_GATEWAY=stub|langchain` и откат `MODEL_GATEWAY=stub` при proxy down УДАЛЕНЫ решением Epoch 6). Прод-путь — только `MODEL_GATEWAY=langchain`; stub — лишь до-миграционное состояние вне LC-пути до зелёного E2E. Rationale: запрет тихих фолбэков, fail-fast по канону.
- Decision: `OpencodeHostService` (embedded) НЕ в LC-пути; serve-Tool fallback УДАЛЁН (Epoch 6): `opencode-serve.tool.ts` не создаётся, выбора primary/fallback по `need.toolCalls` + health нет; `sessions/*` HTTP-контракт и `OPENCODE_URL` живут до конца миграции только как legacy вне LC-пути (отмена п.6–7 старого SDK-плана в этом документе сохраняется в этой части). Rationale: нельзя ломать фронт/чат до готовности LC-пути, но и нельзя молча подменять отказ fallback-веткой — при proxy down только 503.
- Decision: LangGraph `MemorySaver` — только dev/e2e пилота; прод resume — из `run_steps/run_events` (FR6 без повтора side effects — replay LLM запрещён, `intent → confirm` остаётся). Rationale: ADR-0001 §3.3 replay-конфликт.

## Confirmed Plan Items
1. Этап 0 Пилот (изолированный): deps `langchain` + прокси sidecar + `LangChainGateway` + 1 e2e `bind_tools` через paid/Go `tools:true` модель — reason: доказать wire до расширения; artifact: `__tests__/langchain-proxy.e2e.ts`; validation: `tool_calls` дошёл и вернулся в `ToolRegistry.invoke`.
2. Этап 1 Gateway: `MODEL_GATEWAY=langchain` за флагом, allowlist + `EXTERNAL_*` маппинг + LangSmith trace — reason: прод-путь с наблюдаемостью; artifact: config + `lc-tracing.setup.ts`; validation: free-модель → fail-fast, paid → trace в LangSmith.
3. Этап 2 Tools: `lc-tools.adapter.ts` (все `ToolView`), subagent-as-Tool, custom-tools сервис (`.opencode/tools` → HTTP), sidecar MCP каталог — reason: полный цикл агент→инструменты; artifact: адаптер + сервис; validation: `git.recon` + 1 custom tool + 1 MCP tool через LC.
4. Этап 3 Честный 503 (Epoch 6, supersedes прежний «Этап 3 Serve фолбэк»): health-probe `:4010` + `EXTERNAL_UNAVAILABLE` 503 + `Retry-After: 30` + `x-correlation-id`, без retry внутри; serve-ветка не реализуется — reason: запрет тихих фолбэков, fail-fast; artifact: health-probe + маппинг + e2e на 503; validation: e2e с остановленным прокси → 503, а не зелёный serve-путь.
5. Этап 4 Харденинг: журнал как истина (LC-память не источник), `intent → confirm`, fencing `SKIP LOCKED` сохраняется, CoC/lint/build, доки — reason: FR5/FR6/I5/I6; artifact: доки + тесты; validation: `bun run lint/test/build` + graceful-restart resume без повтора эффектов.
6. Этап 5 Чистка (отдельное решение, не в этом документе): удаление stub/legacy — reason: только после стабильности; artifact: —; validation: human approve.

## Open Questions
- Точный нейминг env (`OPENCODE_PROXY_URL/KEYS`, `LANGSMITH_*`, `MODEL_GATEWAY`, `LC_ALLOWLIST`) — зафиксировать на пилоте, `.env.example` правим сразу как код (Epoch 5).
- Нужен ли `PostgresSaver` вообще или только `MemorySaver`-dev — решить после пилота (Epoch 5).

## Next Epoch Focus
- Validation: матрица вариантов, риски/проверки, complexity/risk скоринг, финальный PLAN.md + evolution-log.md.

## Superseded (Epoch 7 — in-place, без нового модуля)

- Decision «новый домен `workers/modules/langchain/`» (`langchain.module.ts`, `langchain-gateway.service.ts`, `opencode-proxy.model.ts`, `lc-tools.adapter.ts`, `lc-tracing.setup.ts`), прокси-sidecar как модуль, `MODEL_GATEWAY`-флаг, `MemorySaver`-чекпоинтер как файл домена — ОТМЕНЕНЫ Epoch 7 полностью.
- Этапы Э0–Э5 в новодоменной трактовке — ЗАМЕНЕНЫ in-place этапами `Э0 Пилот → Э1 Harness-step → Э2 Tools → Э3 Честный 503 → Э4 Харденинг → (Э5 Чистка)` (см. `PLAN.md` §2 и `epoch-07.md`).
- Актуальное состояние — см. `PLAN.md` (in-place) и `epoch-07.md`.

## Terminology (Epoch 8 — глоссарий session/harness/runner; историю не переписывает)

- Читать этот эпох по `PLAN.md §0` (`epoch-08.md`): `session` — только чат, `harness` — только система (`SessionHarnessService`), `runner` — только экземпляр цикла (`SessionTurnRunnerService` + `loop/max-steps/retry`); `freeze/stop/kill/run` — только определение управления runner, не скоуп. Кодовые имена без переименования.

## Config-isolation (Epoch 9 — harness игнорирует opencode-конфиги; историю не переписывает)

- Читать этот эпох с инвариантом `epoch-09.md` (норматив — `PLAN.md` шапка + §§1/5): новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель: `.opencode/opencode.json`; иные — `[???]`, список не зафиксирован) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути (решение Epoch 9, поведение ранее не задано). LangChain-ядро / `:4010` / 503 / in-place / запреты Epoch 6–7 и глоссарий Epoch 8 — без изменений.
