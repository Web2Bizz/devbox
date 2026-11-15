# Evolutionary Plan: silent-auto-j7 — Auto молчит (текст вместо файлов)

## Target State
- Reference: задача «Да, разбери и чини»: auto по промпту `напиши Hello World на NodeJS` возвращает только md-описание, файлов в ФС нет; ask только отвечает, auto должен исполнять.
- Target: auto создаёт файлы hello-node в workspace проекта (src/package.json/test), вызывает tools (виден tool-timeline), повторный промпт идемпотентен; ask по-прежнему только отвечает (readonly).
- Non-negotiable rules:
  - Только план, без кода (эта сессия файлов исходников не меняет).
  - Ask readonly — любой фикс не даёт ask мутаций.
  - Fail-fast без тихих фолбэков; `REPOS_ROOT` — единственный корень storage; fs только через `WorkspacePathService`; логи только `AppLogger` без секретов; DI `private readonly`; uuid `Bun.randomUUIDv7()` (backend AGENTS.md).
  - SSE/контракт sessions заморожен (back-compat) — wire-формы не ломаем.
  - Ветка `feat/cli-cloud-chat`, корень `/media/codebase/@web2bizz/devbox`.

## Current Baseline
- Known facts (из Epoch 2, с путями):
  - `agents/auto.agent.ts:58-142` — Jev classify → executor → decompose/steps/synthesize, прямых runner/tools вызовов нет.
  - `agents/backend.agent.ts` + `ask.agent.ts` — оба через `SessionRunnerService.chat()` (текст).
  - `common/zen/session-runner.service.ts:197-320` — POST `{model, messages}` на Zen chat, поля `tools` нет, возвращает `string`.
  - `common/zen/jev.service.ts:134-250` — choice-classify backend|frontend|fullstack|ask + heuristic fallback, never throws.
  - `sessions/session-harness.service.ts:408-667` — `sendMessage`: file-команды (только дословные) → `sendMessageDirect` (ключ есть, текст + `bufferDirectFrames` текстовыми part + лог `prompt answered directly`) → иначе `sendMessageViaHost` (host, умеет файлы/шелл). `toStreamFrame/recordHostEvent/resolve` — только host-путь.
  - `opencode/opencode-host.service.ts:105-189` — host умеет `sessionCreate/sessionPrompt/sessionShell`.
  - `frontend hooks/useChat.ts:124-275` — `frameToolName` только НЕ-текстовые `message.part.updated`; direct шлёт только текст → `toolTrace` пуст. `chat-tools-timeline.tsx` — пустое состояние.
- Assumptions: route для Hello World — backend/fullstack (точный route покажет CARD-1); Zen Inference поддерживает tools, но это не нужно для итерации 1.
- Confidence: high (90%) — корень в выборе транспорта direct-vs-host + отсутствии исполнения в direct.

## Evolution Log (кратко; полно — evolution-log.md)
1. Грубая гипотеза → 2. Доказательства по 8 путям → 3. Решение D1 auto→host + ask readonly → 4. 5 карточек с файлами/чек-листами → 5. Валидация PASS.

## Current Plan (карточки, порядок строгий)

### CARD-1 `diag: direct-vs-host repro` — диагностика бэка
- Why now: доказать ветвление по ключу — фундамент всех решений (Epoch 2→3).
- Depends on: ничего (старт).
- Files:
  - `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` (sendMessage/tryProjectFileCommand/sendMessageDirect/sendMessageViaHost)
  - `apps/backend/src/common/zen/session-runner.service.ts`, `apps/backend/src/common/zen/jev.service.ts`
  - `apps/backend/src/processes/modules/ai/modules/agents/auto.agent.ts`, `agents.service.ts`, `agents.registry.ts`
  - `apps/backend/src/processes/modules/ai/modules/opencode/opencode-host.service.ts`
- Checklist:
  - [ ] Поднять стенд на `feat/cli-cloud-chat`, создать проект/сессию (agentId=auto).
  - [ ] Кейс A (ключ есть): `напиши Hello World на NodeJS` → записать route (лог `[agents] auto route=`), transport (лог `[sessions] prompt answered directly` vs `prompt accepted`), листинг workspace (ожидание: файлов нет).
  - [ ] Кейс B (ключа нет / `opencode_key_missing`): тот же промпт → host-путь → зафиксировать файлы/снапшот.
  - [ ] Кейс C (дословно): `создай файл hello.js с текстом console.log("hi")` → jailed write (ожидание: файл есть — мост цел).
  - [ ] Приложить логи+листинг к карточке.
- Artifact: repro-отчёт (route/transport/ФС для A/B/C).
- Validation: A=текст без файлов, B=файлы через host, C=файл через мост. Stop: отчёт принят.
- Complexity: low (только наблюдение). Risk: low. Риск-факторы: нет мутаций кода.

### CARD-2 `diag: SSE + tool-timeline` — диагностика фронта
- Why now: доказать, что tool-кадров нет уже на бэке, а не «фронт не рисует» (Epoch 2).
- Depends on: CARD-1 (нужны обе ветки A/B).
- Files:
  - `apps/frontend/src/hooks/useChat.ts` (frameText/frameToolName/toolTrace)
  - `apps/frontend/src/components/chat/chat-window/chat-tools-timeline.tsx`
  - `packages/contracts/src/session/*`, `opencode-event/*`, `opencode-session/*`
- Checklist:
  - [ ] Для кейсов A/B записать сырые SSE frames (типы `session.text.*` vs `message.part.*`, наличие tool-полей).
  - [ ] Зафиксировать `toolTrace`/`activeToolName` (ожидание A: пусто/null; B: текст+возможные tool-frames host).
  - [ ] Подтвердить: контракт менять не надо, фронт в итерации 1 не трогаем.
- Artifact: таблица frames A vs B + вывод.
- Validation: A timeline пуст по причине отсутствия кадров. Stop: вывод зафиксирован.
- Complexity: low. Risk: low.

### CARD-3 `fix: auto → host-исполнение` — core-фикс
- Why now: D1 — единственный слой, где исполнение уже существует (host), без нового tool-протокола (Epoch 3).
- Depends on: CARD-1, CARD-2 (диагностика принята).
- Files:
  - `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` (+ `__tests__/`)
  - при необходимости `sessions.dto.ts` (флаг, по умолчанию без изменения wire)
  - e2e: `apps/backend/src/processes/modules/ai/modules/sessions/__tests__/`, `agents/__tests__/`
- Checklist:
  - [ ] В `sendMessage()` добавить гейт: `agentId==='auto'` (резолв через `resolveAgentId`/`getAgent`, как в `sendMessageDirect:597-601`) → пропуск direct, всегда `sendMessageViaHost` (исключение: явные file-команды уже обработаны выше — порядок сохранить).
  - [ ] Сохранить: `assertServeUser`, project-jail `resolveProjectDirectory`, `ensureAssistantRecorder` ДО prompt, `captureSnapshot/recordTurnStart`, project-scoped `resolve` в `streamEvents`, `interrupt` (busyDirect+host), jail `jailFile` 403.
  - [ ] Логи `AppLogger` однострочники (`[sessions] auto forced host`), без секретов; DI `private readonly`; uuid `Bun.randomUUIDv7()`.
  - [ ] Юнит-спеки: auto→host при ключе, ask→direct без изменений, unknown agent 404, traversal 403.
  - [ ] `bun run lint` + `bun run build` зелёные (e2e требует Docker — отметить).
- Artifact: дифф харнесса + спеки.
- Validation: Hello World через auto создаёт файлы (CARD-5 e2e). Stop: lint/build + спеки зелёные.
- Complexity: medium (1 файл-ядро + ветвление транспорта + снапшоты). Risk: medium — факторы: смена транспорта (billing/key), host-нагрузка. Откат: флаг `AUTO_FORCE_HOST` одной строкой.
- Supersedes: подозрения «раннер не выполняет tools / harness не маппит кадры» — для auto-пути больше не актуальны (исполняет host); для direct остаются как follow-up.

### CARD-4 `fix: auto-промпт harden` — страховка от текстовых моков
- Why now: даже через host декомпозиция должна требовать файловый результат, а не md-описание (Epoch 1 симптом).
- Depends on: CARD-3 (можно параллельно после CARD-1, пометить blocked-by CARD-3 для мержа).
- Files:
  - `apps/backend/src/processes/modules/ai/modules/agents/auto.agent.ts`
  - `backend.agent.ts`, `frontend.agent.ts`, `fullstack.agent.ts` (system-промпты)
- Checklist:
  - [ ] Дописать в decompose/step/synthesize требование «результат — файлы в workspace проекта + краткая сводка», запрет «только markdown без файлов».
  - [ ] `UNCLEAR_REQUEST_MESSAGE` и ask-ветка без изменений.
  - [ ] Спеки `parseSteps` + системные строки; `bun run lint`.
- Artifact: дифф промптов + спеки.
- Validation: synthesize без файлов считается незавершённым (ручная проверка). Stop: lint зелёный.
- Complexity: low. Risk: low (только строки).

### CARD-5 `verify: приёмка Hello World` — Done-гейт
- Why now: критерии задачи — единственный выход (Epoch 3→4).
- Depends on: CARD-3, CARD-4.
- Files: e2e-сьют (существующие `__tests__` + ручной чек-лист), workspace проекта.
- Checklist:
  - [ ] E2E-1: auto `напиши Hello World на NodeJS` → в project `directory`: `hello.js` (или `src/index.js`) с `console.log`, `package.json` (`name hello-node`, `scripts.start/test`), тест (`test` зелёный), файлы видны через проектный листинг.
  - [ ] E2E-2: tool-timeline непуст (host frames), `useChat` без изменений кода.
  - [ ] E2E-3: повторный тот же промпт → те же файлы тем же содержимым, без дублей/падений (идемпотентность ФС).
  - [ ] E2E-4: ask `объясни что такое Hello World` → только текст, файлов нет (readonly-регресс).
  - [ ] E2E-5: interrupt во время auto → честный `{interrupted:true}`, без полу-файлов вне снапшота (revert-путь цел).
- Artifact: e2e-лог + листинг ФС + скрин timeline.
- Validation: все 5 E2E зелёные. Stop condition (Done): критерии из Target State выполнены.
- Complexity: medium (e2e + Docker/testcontainers). Risk: medium — факторы: external (Zen/host), data (workspace). Митигация: одноразовый проект, снапшоты.

## Conflict Check
- Status: PASS — блокеров нет.
- Транспорт vs биллинг: auto уходит с per-user Zen на embedded host — serve-auth и project-gate сохранены; ключ всё равно нужен для сессии; откат флагом.
- `common/` scope: сигнатуры `SessionRunnerService.chat/JevService.classify` не меняются — стрелка слоёв цела.
- Контракт SSE: wire-формы не меняются — фронт без диффа в итерации 1.
- Ask readonly: ask-путь не трогаем ни в одной карточке, регресс в CARD-5.
- Resolutions: follow-up трек (OpenAI-tools в Zen + permission approve-мост) вынесен за Done, не блокирует.

## Open Questions (только follow-up, не блокируют Done)
- OpenAI `tools` в Zen chat + executor-loop в `AutoAgent` (стратегия B) — после приёмки.
- Permission approve-UX (`permission.asked` без UI) — отдельной карточкой после приёмки.
- `body.model` проброс в host prompt (сейчас pinned at create) — оставить как есть.

## Next Action
- Завести 5 карточек (CARD-1…5) в трекере по разделам выше и стартовать с CARD-1; план-директория: `.plans/silent-auto-j7/`.
