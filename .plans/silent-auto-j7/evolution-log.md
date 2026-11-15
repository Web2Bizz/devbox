# Evolution Log: silent-auto-j7

## Step 1. Грубая гипотеза (Epoch 1)
- Hypothesis: auto — чистый текст без инструментов (промпт/транспорт/харнесс/SSE).
- Check: симптом + прошлые логи (steps 4/5→5/5→synthesize→prompt answered directly).
- Finding: цепочка проходит, файлов нет — виноват слой исполнения, не роутинг.
- Decision: трек диагностика→фикс→проверка, не чинить вслепую.
- Consequence: нужна evidence-эпоха по точным путям.
- Next step: прочитать 8 групп путей.

## Step 2. Заземление (Epoch 2)
- Hypothesis: каждый слой доказуемо текстовый.
- Check: прочитаны auto.agent.ts, backend/ask agents, session-runner.service.ts, jev.service.ts, session-harness.service.ts, sessions.service.ts, opencode-host.service.ts, useChat.ts, timeline, contracts.
- Finding: Zen chat тела `{model,messages}` без `tools`; `sendMessageDirect` кладёт текст + текстовые part; `frameToolName` текстовые part игнорит; host-путь единственный исполняющий; выбор транспорта — по наличию ключа.
- Decision: гипотеза подтверждена (high 90%).
- Consequence: фикс — смена транспорта для auto, а не починка фронта.
- Next step: выбрать стратегию, зафиксировать конфликты.

## Step 3. Стратегия (Epoch 3)
- Hypothesis: три стратегии A(host)/B(tools в Zen)/C(парсер шагов).
- Check: `tryProjectFileCommand` только дословный; host уже умеет файлы/шелл/снапшоты; direct всегда при ключе.
- Finding: A — минимальный риск (переиспользует jail/snapshot/recorder); B трогает `common/zen` scope; C хрупок.
- Decision: D1 A primary + B follow-up; D2 ask readonly; D3 SSE не ломаем; D4 диагностика первична.
- Consequence: 4 план-пункта → развернуть в карточки.
- Next step: файлы/чек-листы/границы. Superseded: вопрос «какой флаг» — решён в Epoch 4 (всегда-host для auto).

## Step 4. Карточки (Epoch 4)
- Hypothesis: A реализуем диффом в `sendMessage()` + harden промптов.
- Check: точки `sendMessage:408-443`, `sendMessageDirect:582-667`, `sendMessageViaHost:719-780`, `toStreamFrame/streamEvents`, `resolve/askQuestion`, `WorkspacePathService/jailFile`, scope-правила.
- Finding: оба пути снапшотят (revert цел); host-frames уже re-keyed (фронт без изменений); jail prefix-check на месте.
- Decision: 5 карточек (2 diag + 2 fix + 1 verify); гейт явный `agentId==='auto'`; approve-модала в итерации 1 нет; hello-артефакты в gated `directory`.
- Consequence: готовность к валидации.
- Next step: conflict/complexity/риск/тесты → финал.

## Step 5. Валидация (Epoch 5)
- Hypothesis: план полон и бесконфликтен.
- Check: lint/build/test/e2e-паттерны, scope-стрелка, контракт-фріз, риски, тест-гэпы, идемпотентность.
- Finding: рисковые точки митигированы (откат флагом, serve-auth сохранён, ask-регресс).
- Decision: PASS, эпох достаточно, next — завести карточки и стартовать CARD-1.
- Consequence: PLAN.md + evolution-log.md финализированы.
- Next step: handoff вызывающей сессии (`.plans/silent-auto-j7/`).
