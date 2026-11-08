# Epoch 5: Validation — матрица, риски, скоринг, приёмка

## Hypothesis
Архитектура (Epoch 4) и решения (Epoch 3) покрывают все 4 раздела ТЗ. Валидируем полноту и ставим оценки.

## Evidence Found
- File: `apps/backend/src/processes/modules/ai/modules/opencode/__tests__/keys.e2e.ts` — эталон e2e-скана секретов (расширить на `LANGSMITH_*`/proxy-ключи: без Bearer/URL в логах).
- File: `apps/backend/src/common/sse/sse-relay.ts` + `session-harness` — механика replay/cursor (LC-стрим маппится в `delta` кадры, терминальный `stream.error` сохраняется).
- File: `apps/backend/CODE_OF_CONDUCT.md` + `apps/backend/AGENTS.md` — `AppLogger` only, `warn/error` без `\n`, C4-gate, `__tests__/`-только-тесты, `utils/<name>/` правило.
- Check: `git merge-base --is-ancestor 0300575 HEAD` должен быть true на каждом этапе (Forward-Only); `reset --hard`/`push --force` запрещены.
- Scoring (evol-plan шкала, пересчитано в Epoch 6): files ≈ 10–12 (gateway+model+adapter+tracing+custom-service+mcp-catalog+config+contracts-mirror+docs+e2e; `opencode-serve.tool.ts`/`ToolDescriptor`-фолбэк исключены), deps ≈ 5 (`@langchain/core`, `@langchain/openai`, `langgraph`, `@langchain/mcp-adapters`/`@modelcontextprotocol/sdk`, `langsmith`), unknowns = 2 (wire `tool_calls` прокси v1.11.2↔v2 на пилоте; zod-v4 адаптер; compose `:4010` топология — health/503-контракт уточняется Э3), type = `update` (новый домен в существующем монолите, не new-module с нуля).

## Decisions
- Decision: complexity `score 13/20, level medium` (Epoch 6 пересчёт: −1 за удаление serve-Tool ветки; граница high снята, deps/external прежние, инкрементальные этапы снижают).
- Decision: risk `score 5/8, level medium` (factors `[breaking, data, security, external]` без изменений численно; mitigation изменена Epoch 6: вместо serve-фолбэка — честный 503 `EXTERNAL_UNAVAILABLE + Retry-After: 30 + x-correlation-id`, без retry внутри). Rationale: wire/403/503-fail-fast — главные; journal/dedup уже есть; тихий фолбэк как риск-класс устранён запретом.
- Decision: приёмка = 4 чек-листа раздела 4 (E2E bind_tools, регресс журнала/SSE, CoC/lint, секреты/CoC-логи) + e2e отказа: остановленный прокси → 503 (не serve-путь).
- Decision: приёмка = 4 чек-листа раздела 4 (E2E bind_tools, регресс журнала/SSE, CoC/lint, секреты/CoC-логи).
- Alternatives considered: занижение risk до low — rejected (внешний прокси + paid-ключи + session semantics = минимум medium).

## Confirmed Plan Items
1. Матрица LC↔OC (6 строк: proxy-model единственный путь / serve-Tool ЗАПРЕЩЁН / CLI не-fallback / custom-tools→LC / sidecar-MCP / LangSmith) с колонками когда/как/ограничения — reason: раздел 3 ТЗ + запрет Epoch 6; artifact: PLAN.md §3; validation: V2 имеет только запрет, без инструкции к реализации.
2. Риски R1–R6 + митигации + проверки (R1 без V2-фолбэка, R2 с 503-контрактом вместо `need.toolCalls + health`-выбора) — reason: раздел 4 ТЗ; artifact: PLAN.md §4; validation: каждый риск закрыт тестом или гейтом; отказ закрыт e2e на 503.
3. Порядок этапов 0→4 (Э1 без fallback-переключателя, Э3 честный 503 вместо serve) + что отключаем/оставляем — reason: раздел 2 ТЗ; artifact: PLAN.md §2; validation: DAG + отсутствие runtime-отката `MODEL_GATEWAY=stub`.
4. Reuse-заметки (ToolView, McpClient, SubagentJob, .opencode/tools, AppLogger/correlation, journal) — reason: не переписывать рабочее; artifact: PLAN.md §5; validation: список файлов.

## Open Questions
- Нет открытых — все unknowns перенесены в пилот Этапа 0 как задачи проверки (намеренно, не блокеры документа).

## Next Epoch Focus
- Финал: `PLAN.md` (4 раздела + порядок + reuse) и `evolution-log.md` (история решений), отчёт пользователю.

## Superseded (Epoch 7 — in-place, без нового модуля)

- Скоринг Epoch 5–6 (complexity 13/20 medium, risk 5/8 medium, files 10–12 под новый домен, «новый домен в существующем монолите») — ПЕРЕСЧИТАН Epoch 7: complexity `14/20 medium-high` (правок 15–18 существующих файлов, deps 5, unknowns 2, type update), risk `6/8 medium-high` `[breaking,data,security,external]` (+1 за breaking-поверхность живого пути: harness 1581 + useChat 1101 + SSE).
- Матрица/риски/порядок в новодоменной трактовке — ЗАМЕНЕНЫ in-place версией (см. `PLAN.md` §§2–5 и `epoch-07.md`).
- Актуальное состояние — см. `PLAN.md` (in-place) и `epoch-07.md`.

## Terminology (Epoch 8 — глоссарий session/harness/runner; историю не переписывает)

- Читать этот эпох по `PLAN.md §0` (`epoch-08.md`): `session` — только чат, `harness` — только система (`SessionHarnessService`), `runner` — только экземпляр цикла (`SessionTurnRunnerService` + `loop/max-steps/retry`); `freeze/stop/kill/run` — только определение управления runner, не скоуп. Скоринг этого эпоха пересчитан Epoch 7 (см. пометку Superseded выше). Кодовые имена без переименования.

## Config-isolation (Epoch 9 — harness игнорирует opencode-конфиги; историю не переписывает)

- Читать этот эпох с инвариантом `epoch-09.md` (норматив — `PLAN.md` шапка + §§1/5): новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель: `.opencode/opencode.json`; иные — `[???]`, список не зафиксирован) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути (решение Epoch 9, поведение ранее не задано). LangChain-ядро / `:4010` / 503 / in-place / запреты Epoch 6–7 и глоссарий Epoch 8 — без изменений.
