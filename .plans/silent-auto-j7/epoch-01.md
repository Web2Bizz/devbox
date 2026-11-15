# Epoch 1: Coarse hypothesis — почему auto молчит

## Hypothesis
- Auto по промпту `напиши Hello World на NodeJS` возвращает md-описание, но файлов в ФС нет — значит цепочка `Jev classify → domain executor → Zen chat` работает как **чистый текст без инструментов**.
- Ask только отвечает — это корректное поведение, его трогать нельзя.
- Подозреваемые слои (по убыванию вероятности): (1) в системном промпте auto/domain-агентов нет tool-calling и нет упоминания workspace/tools; (2) `SessionRunnerService.chat` — plain OpenAI chat без `tools` параметра, Zen возвращает только текст; (3) раннер/харнесс не выполняет tool-кадры — `sendMessageDirect` просто кладёт `answer` строкой в history + `bufferDirectFrames` как текст; (4) SSE-контракт фронта (`useChat frameToolName/toolTrace`) ждёт `message.part.updated` с tool-полями, которых direct-путь никогда не эмитит.
- Ветка `feat/cli-cloud-chat`, корень `/media/codebase/@web2bizz/devbox`. Логи прошлого: zen chat 450мс ok, auto steps 4/5→5/5→synthesize→prompt answered directly — цепочка проходит, но каждый шаг — текст.

## Evidence Found
- Симптом из задачи: вне `.git` ничего нет после auto-промпта.
- Логи прошлого (со слов заявителя): decompose ok, steps ok, synthesize ok, `prompt answered directly` — т.е. `SessionHarnessService.sendMessageDirect` завершён.
- Пока без чтения файлов (грубая гипотеза).

## Decisions
- Decision: идём по треку `диагностика → фикс → проверка`, а не сразу чинить.
- Alternatives considered: сразу добавить tools в Zen chat — отвергнуто, без диагностики непонятно какой слой виноват (промпт vs транспорт vs харнесс vs фронт).
- Rationale: риск сломать ask/direct-путь высок, нужен план с карточками.

## Confirmed Plan Items
1. Зафиксировать target state и критерии приёмки — причина: без них диагностика расползётся; артефакт: PLAN.md §Done; валидация: ревью.
2. Провести evidence-эпоху по точным путям из задачи — причина: гипотезы надо заземлить; артефакт: epoch-02.md; валидация: пути+строки.

## Open Questions
- Какой executor выбирает Jev для `напиши Hello World на NodeJS` (backend/frontend/ask/unclear)?
- Есть ли вообще tool-протокол в Zen chat (OpenAI tools) или только host `sessionPrompt` умеет в файлы?
- Что показывает tool-timeline фронта для direct-ответа (пусто vs текст)?

## Next Epoch Focus
- Прочитать точные пути бэка/фронта, зафиксировать факты: auto.agent, agents.service/registry, session-harness (toStreamFrame/recordHostEvent/resolve), sessions.service, opencode-host, zen/jev, useChat, timeline, contracts schema.
