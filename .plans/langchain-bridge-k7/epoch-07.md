# Epoch 7: In-place — переделка текущей системы без нового модуля

## Hypothesis

Подтвержденная задача Epoch 7 отменяет новодоменную гипотезу Epoch 4 («новый домен `workers/modules/langchain/`»).
Новое целевое состояние: LangChain/LangGraph-JS — библиотека внутри существующих сервисов (точка встройки —
`SessionHarnessService` step-executor → `SessionTurnRunnerService.runTurn` → `ToolDispatchService.dispatch`),
нового модуля/домена нет, `MODEL_GATEWAY`-переключателя как нового пути нет.
Сохраняется без изменений: LangChain — ядро управления, OpenCode-провайдер через прокси `:4010` — primary и
единственный прод-путь, только paid/Go `tools:true`, при недоступности OpenCode — честный 503
(`EXTERNAL_UNAVAILABLE` + `Retry-After: 30` + `x-correlation-id`), fallback запрещён (Epoch 6 в силе).

## Evidence Found

- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` (1581 строк) — точка встройки LC step-executor; probe уже есть (`streamEvents` → `relaySse.probe` → `host.getHost()` → `EXTERNAL_UNAVAILABLE` до SSE-заголовков, строка ~1150–1160); send-путь расширяется тем же маппингом.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/modules/runner/runner.service.ts` + `loop.ts` + `max-steps.ts` + `retry.ts` — готовый цикл шаг→dispatch→nextRequest (LC `Command`/`ToolNode` эквивалент), логику не менять.
- File: `apps/backend/src/processes/modules/ai/modules/tools/tool-registry.service.ts` + `tool-dispatch.service.ts` + `tools.bootstrap.ts` + 8 tools + `tool-jail.ts` — исполнение/джейл уже есть; LC маппинг — строки внутри, не `lc-tools.adapter.ts`.
- File: `apps/backend/src/processes/modules/ai/modules/agents/agent.base.ts`, `agents.registry.ts`, `agents.service.ts`, `model-fallback.ts` (`ASK_FALLBACK_MODELS` + `isFailFastKeyError`) — allowlist/гейт `tools:true` in-place.
- File: `apps/backend/src/processes/modules/ai/modules/agents/modules/subagent/subagent-job.service.ts` — subagent уже `ToolSettlement`-совместим.
- File: `apps/backend/src/processes/modules/workers/modules/tool-registry/mcp-client.ts` + `mcp-tool-source.ts` — общий MCP-каталог для LC-стороны, своего сервера нет.
- File: `apps/backend/src/processes/modules/workers/modules/model-gateway/model-gateway.ts` (`ModelGateway.stream`, `ToolView`-проекция D3) — граница уже есть, новый gateway-файл не создаётся.
- File: `apps/backend/src/common/external/external-error.ts` (335 строк, `EXTERNAL_*` + `httpStatusFor`) — 503-контракт уже есть, переиспользовать.
- File: `apps/backend/src/common/sse/sse-relay.ts` (280 строк, probe/heartbeat/`id:`/терминальный `stream.error`/`Last-Event-ID`) — транспорт уже есть, не менять.
- File: `apps/frontend/src/api/sessions-client.ts` (367 строк) + `apps/frontend/src/hooks/useChat.ts` (1101 строк, `formatError`/`toErrorMessage`, `toolTrace`, `frameToolName`) + `components/chat/chat-thread/ChatThread.tsx` + `components/chat/chat-tool-timeline/ChatToolTimeline.tsx` — фронт in-place (честный 503 через существующий `ErrorState`), новых компонентов нет.
- Check: `rg "langchain|MODEL_GATEWAY" apps/backend/src packages/contracts/src` — пусто (LC-стек отсутствует, переключателя нет): Э0 ставит deps, переключатель не вводится вообще.
- Pattern (backend-канон, сохраняется): fail-fast без тихих фолбэков, `AppLogger + x-correlation-id`, `__tests__/`-покрытие, зеркало `contracts/openapi.yaml` ↔ `packages/contracts` только additive.

## Decisions

- Decision: новый домен `workers/modules/langchain/` (`langchain.module.ts`, `langchain-gateway.service.ts`, `opencode-proxy.model.ts`, `lc-tools.adapter.ts`, `lc-tracing.setup.ts`) — НЕ СОЗДАВАТЬ. Rationale: подтвержденная задача Epoch 7 + живая точка встройки (harness/runner/dispatch) уже покрывает цикл; новый домен дублировал бы её. Supersedes: Decision Epoch 4 «новый домен `workers/modules/langchain/`» — отменено полностью.
- Decision: `MODEL_GATEWAY=stub|langchain`-переключатель как новый путь/рантайм-фолбэк — НЕ ВВОДИТЬ. Прод-путь — LC step внутри harness; stub — лишь до-миграционное состояние вне LC-пути до зелёного E2E. Rationale: перестраивать границу прототипа не нужно — прод-путь чата уже harness/runner. Supersedes: все `MODEL_GATEWAY`-формулировки Epoch 4–6 (включая «единственный `MODEL_GATEWAY=langchain`»).
- Decision: маппинг `ToolView/ToolDefinition → DynamicStructuredTool` — строки внутри `tool-registry.service.ts`/`tools.bootstrap.ts`; LangSmith — обёртка внутри `session-harness.service.ts`; MCP — существующие `mcp-client.ts`/`mcp-tool-source.ts`. Rationale: in-place, без новых файлов-модулей.
- Decision: запреты Epoch 6 подтверждены без изменений — serve Tool ветка, переход на stub при proxy down, выбор `need.toolCalls + health`, CLI как прод-фолбэк. Rationale: подтвержденная задача Epoch 7 явно сохраняет «503 без fallback».
- Alternatives considered: (a) оставить новый домен и параллельно править harness — rejected (дублирование границ, запрещено задачей); (b) ввести `MODEL_GATEWAY`-переключатель «для безопасности отката» — rejected (прямо запрещено задачей; откат = Forward-Only вперёд, не свитч); (c) вынести LC step в отдельный injectable-файл вне домена sessions — rejected (это уже новый модуль под другим именем; встройка — метод/хелпер внутри harness + существующий runner).
- Superseded (данным эпохом): новодоменные формулировки Epoch 1 («LangChain-слой», «ModelGateway → LC-граф»), Epoch 2 (п.2 «новый `LangChainGateway extends ModelGateway`», validation Epoch 4 п.1), Epoch 3 (п.1 `workers/modules/model-gateway/langchain-gateway.ts`), Epoch 4 целиком в части нового домена/прокси-sidecar-как-модуля/флага, Epoch 5 scoring-строка «новый домен в существующем монолите» и files-оценка под него, PLAN.md ревизии до Epoch 7 §§1–5.

## Confirmed Plan Items

1. Архитектура in-place без fallback-узла и без нового домена (диаграмма: harness-step → runner → dispatch → registry/MCP; probe → `external-error.ts` → 503 → `relaySse` → sessions-client → useChat → ChatThread/Timeline) — reason: единственный прод-путь + честный отказ + ноль новых модулей; artifact: PLAN.md §1; validation: в §1 нет `workers/modules/langchain/`, `MODEL_GATEWAY`, `lc-*.ts` как создаваемых; запрет перечислен явно.
2. Этапы Э0→Э4 in-place с точными существующими файлами (harness-step → allowlist/маппинг → tools-регистрация → 503-probe → харденинг фронта/журнала) — reason: переделка живого чат-пути без новой границы; artifact: PLAN.md §2; validation: каждый этап называет существующие пути; нового домена нет ни в одном этапе.
3. Матрица V1 (единственный путь через harness-step + 503) / V2 (ЗАПРЕЩЁН) / V3 (НЕ fallback) / V4 (регистрация через существующий bootstrap) / V5 (существующий mcp-client) / V6 (обёртка внутри harness) — reason: закрыть неверные стыки без новых модулей; artifact: PLAN.md §3; validation: V4–V6 не содержат новых файлов/модулей.
4. Риски R1–R6 in-place (R1 wire в harness-step, R2 allowlist в agents + `external-error.ts`, R3 журнал + неизменный runner, R4 скан секретов, R5 additive-контракты + фронт без новых компонентов, R6 stateless-прокси + cursor) и приёмка отказа — reason: митигация без тихого фолбэка на живом пути; artifact: PLAN.md §4; validation: каждый риск закрыт тестом/гейтом существующего файла; e2e отказа ожидает 503.
5. Reuse только существующих файлов + явный запрет-список Epoch 7 — reason: не переписывать рабочее, зафиксировать отсутствие нового домена; artifact: PLAN.md §5; validation: запрет-список содержит `workers/modules/langchain/*`, `MODEL_GATEWAY`-переключатель, `opencode-serve.tool.ts`, новый custom-tools сервис, свой MCP-сервер, новые фронт-компоненты.
6. Скоринг пересчитан: complexity `14/20 medium-high` (было 13 medium: −0 за удаление домена уже учтено в Epoch 6, +1 за in-place регресс живого чат-пути: файлов к правке 15–18, deps 5, unknowns 2, type update); risk `6/8 medium-high` (было 5/8 medium: +1 за breaking-поверхность живого пути harness 1581 + useChat 1101 + SSE; factors `[breaking,data,security,external]`; mitigation — честный 503 + e2e регресс журнала/SSE) — reason: честная цена переделки без изоляции нового домена; artifact: epoch-05.md пометка + evolution-log; validation: files 15–18 существующие, deps 5, unknowns 2.

## Open Questions

- Нет открытых — unknowns (wire `tool_calls` прокси v1.11.2↔v2 на пилоте; zod-v4 адаптер внутри существующего registry; compose `:4010` топология + health/503-контракт send-пути) остаются задачами пилота Э0/Э3, не блокерами документа.

## Next Epoch Focus

- Дальнейшие эпохи — только при изменении канона 503, провенанса прокси или allowlist `tools:true`; новых доменов/переключателей не вводить.

## Terminology (Epoch 8 — глоссарий session/harness/runner; историю не переписывает)

- Этот эпох читать по `PLAN.md §0` (`epoch-08.md`): `session` — только чат, `harness` — только система (`SessionHarnessService` step-executor), `runner` — только экземпляр цикла (`SessionTurnRunnerService` + `loop/max-steps/retry`); `freeze/stop/kill/run` — только определение управления runner, не скоуп работ. Кодовые имена без переименования.

## Config-isolation (Epoch 9 — harness игнорирует opencode-конфиги; историю не переписывает)

- Читать этот эпох с инвариантом `epoch-09.md` (норматив — `PLAN.md` шапка + §§1/5): новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель: `.opencode/opencode.json`; иные — `[???]`, список не зафиксирован) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути (решение Epoch 9, поведение ранее не задано). LangChain-ядро / `:4010` / 503 / in-place / запреты Epoch 6–7 и глоссарий Epoch 8 — без изменений.
