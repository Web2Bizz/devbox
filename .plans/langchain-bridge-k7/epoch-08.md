# Epoch 8: Terminology-fix — session / harness / runner (документ, без кода и карточек)

## Hypothesis

Подтвержденная задача Epoch 8: зафиксировать терминологию `session / harness / runner` в плане-документе
`.plans/langchain-bridge-k7/` без рефакторинга кода, без переименования сущностей, без новых сущностей,
без изменения поведения LangChain-ядра / прокси `:4010`, с сохранением запрета fallback и честного 503.
Смешения старых эпох (`harness` как процесс, `runner` как система, `session` как состояние/хранилище)
устраняются нормативным глоссарием `PLAN.md §0`; история решений не переписывается.
Управление runner (`freeze/stop/kill/run`) — только определение термина, НЕ новый скоуп работ Epoch 7.

## Evidence Found

- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.types.ts` — `SessionHarness` = orchestrator чатов за `/api/v1/sessions*` (доменный словарь `SessionInfo`/`SessionMessage`, без opencode wire через границу) → **harness = система**.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` (1581 строк) — `SessionHarnessService implements SessionHarness`; probe уже есть (`streamEvents` → `relaySse.probe` → `host.getHost()` → `EXTERNAL_UNAVAILABLE` до SSE-заголовков); send-путь расширяется тем же маппингом → **точка LC step-executor внутри harness-системы**.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/modules/runner/runner.service.ts` — `SessionTurnRunnerService.runTurn` (step → dispatch → nextRequest, `maxSteps`/`retry`, `finishReason 'stop'`, `interrupt`) + `loop.ts` + `max-steps.ts` + `retry.ts` → **runner = экземпляр цикла/обёртка, процесс harness**.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-history.repository.ts` + `common/db/schema.ts` (`run_runs/run_steps/run_events`) — журнал чата как истина → **session = чат, журнал хранит чат, а не «состояние провайдера»**.
- File: `apps/frontend/src/api/sessions-client.ts` + `hooks/useChat.ts` + `chat-thread/ChatThread.tsx` + `chat-tool-timeline/ChatToolTimeline.tsx` — фронт чата session (честный 503 через существующий `ErrorState`) → **session на фронте = тот же чат**.
- Check: `grep -rn "sessions\|harness\|runner" apps/backend/AGENTS.md` — канон без правок кода; AGENTS/docs в этом эпохе только ссылки (§0 PLAN.md), файлы AGENTS/docs не правим.
- Смешения к устранению (найдены в ревизиях до Epoch 8): шапка `sessions/harness/runner` без расшифровки; `H[SessionHarnessService ...]` / `R[SessionTurnRunnerService ...]` без ярлыков система/экземпляр; `Session-state в прокси` (читалось как session = состояние); `session-harness replay` (читалось как сущность); `runner/loop.ts... — цикл` без слова «экземпляр»; reuse-строка harness без «система».

## Decisions

- Decision: глоссарий `PLAN.md §0` — нормативен для всего документа: `session` = только чат пользователя с ИИ; `harness` = только агентская система (управляет агентами, инструментами, MCP, инструкциями; владеет LC step-executor, probe, 503); `runner` = только процесс harness, экземпляр цикла/обёртка (`шаг → dispatch → nextRequest`); `freeze/stop/kill/run` = только определение управления runner (пауза/останов/убийство/запуск: `interrupt`/`finishReason 'stop'`/`runTurn`), НЕ скоуп работ. Rationale: подтвержденная задача строго по формулировке; устраняет смешения без рефакторинга.
- Decision: кодовые сущности НЕ переименовываются — только маппинг «термин → носитель»: `SessionHarness`/`SessionHarnessService` = harness-система; `SessionTurnRunnerService` + `loop/max-steps/retry` = runner-экземпляр; `SessionInfo`/`SessionMessage`/`sessionId`/журнал/`sessions-client`/`useChat`/`ChatThread/Timeline` = session-чат. Rationale: Forward-Only, план не трогает код.
- Decision: новых сущностей не вводить; поведение LangChain-ядра / прокси `:4010` / 503-контракт / in-place запрет Epoch 7 — без изменений. Rationale: ограничения подтвержденной задачи.
- Decision: `AGENTS.md`/docs — только ссылки в `PLAN.md §0`, правок файлов AGENTS/docs и кода — ноль. Rationale: «править ссылками если нужно, без кода».
- Alternatives considered: (a) переименовать `SessionHarnessService`/`SessionTurnRunnerService` под глоссарий — rejected (прямо запрещено: без переименования сущностей в коде); (b) ввести отдельную сущность «runner-manager» для `freeze/stop/kill/run` — rejected (запрещено: не выдумывать новые сущности; управление runner — только определение); (c) переписать историю Epoch 1–7 под новые термины — rejected (правило «preserve decision history», только пометки `Superseded/Terminology` + актуальное состояние в `PLAN.md §0`).
- Superseded (данным эпохом, только терминология): смешения `harness как процесс`, `runner как система`, `session как состояние/хранилище` в Epoch 1–7 и ревизиях `PLAN.md` до Epoch 8 — читать по глоссарию §0; смысловые решения Epoch 6 (fallback-запрет, 503) и Epoch 7 (in-place, без нового модуля) — ПОДТВЕРЖДЕНЫ без изменений.

## Confirmed Plan Items

1. Глоссарий `PLAN.md §0` + расшифровка шапки + ярлыки `Harness-система`/`Runner-экземпляр` в диаграмме + `session = чат` в R6/reuse — reason: нормативная точка чтения всего документа; artifact: `PLAN.md §0` + точечные правки §§1/4/5; validation: в документе нет bare-`harness`-как-процесс / bare-`runner`-как-система / bare-`session`-как-хранилище вне кавычек кодовых имён.
2. Пометки `Terminology (Epoch 8)` в `epoch-01..07.md` (без переписывания истории) — reason: трассируемость; artifact: appended-разделы; validation: каждый файл ссылается на `PLAN.md §0` + `epoch-08.md`.
3. Запись `evolution-log.md` Epoch 8 — reason: история решений; artifact: appended-раздел; validation: скоринг Epoch 7 неизменен, скоринг термин-правки зафиксирован.
4. Ноль кода, ноль карточек: `git status --porcelain` показывает изменения только внутри `.plans/langchain-bridge-k7/` — reason: Forward-Only + формат документ; artifact: diff только `PLAN.md` + `epoch-*.md` + `evolution-log.md`; validation: `git merge-base --is-ancestor 0300575 HEAD` true.

## Open Questions

- Нет открытых — unknowns отсутствуют (термин-правка, код не затрагивается, поведение не меняется).
- AGENTS/docs: ссылок `PLAN.md §0` достаточно; отдельных правок `apps/backend/AGENTS.md` / `packages/contracts/AGENTS.md` / `docs/*` не требуется (если потребуется — только ссылки, без кода, отдельным решением).

## Next Epoch Focus

- Дальнейшие эпохи — только при изменении канона 503, провенанса прокси `:4010` или allowlist `tools:true` (как зафиксировано Epoch 7); терминологию считать закрытой этим эпохом.

## Scoring (термин-правка Epoch 8; скоринг плана Epoch 7 неизменен)

- Правка Epoch 8: complexity `2/20 low` (файлов 9 существующих `.md`, deps 0, unknowns 0, type docs) — reason: только текст, код/поведение/контракты не затрагиваются; validation: diff только `.plans/langchain-bridge-k7/`.
- Правка Epoch 8: risk `1/8 low` (factors `[docs]` — вне шкалы breaking/data/security/external; тихих фолбэков/контрактных изменений нет) — reason: глоссарий не меняет исполнение; validation: 503/in-place запреты дословно сохранены.
- План Epoch 7 (подтвержден без изменений): complexity `14/20 medium-high`, risk `6/8 medium-high [breaking,data,security,external]` — reason: переделка живого чат-пути in-place; validation: см. `epoch-07.md` п.6.

## Config-isolation (Epoch 9 — harness игнорирует opencode-конфиги; историю не переписывает)

- Читать этот эпох с инвариантом `epoch-09.md` (норматив — `PLAN.md` шапка + §§1/5): новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель: `.opencode/opencode.json`; иные — `[???]`, список не зафиксирован) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути (решение Epoch 9, поведение ранее не задано). LangChain-ядро / `:4010` / 503 / in-place / запреты Epoch 6–7 и глоссарий Epoch 8 — без изменений.
