# Epoch 2: Evidence gathering — что реально делает код

## Hypothesis
Из Epoch 1: auto — чистый текст без инструментов. Проверяем чтением точных путей.

## Evidence Found
- File: `apps/backend/src/processes/modules/ai/modules/agents/auto.agent.ts` (1–143) — `AutoAgent.ask()`: Jev classify → `executorFor(route)` → `runChain()`: decompose (`Разбей задачу на пронумерованные шаги`), N шагов `execute.ask(...)`, synthesize (`Собери итоговый ответ`). Ни одного вызова runner/tools/workspace напрямую; комментарий подтверждает: «прямых вызовов runner здесь нет». `MAX_STEPS=5`, `parseSteps` режет по `^\d+[.)]`.
- File: `apps/backend/src/processes/modules/ai/modules/agents/backend.agent.ts`, `ask.agent.ts` — оба `ask()` идут через `SessionRunnerService.chat(userId, question, {model, system?, correlationId})` с fallback-цепочкой `ASK_FALLBACK_MODELS`. `BACKEND_SYSTEM` — только роль («Ты backend-разработчик…»), ни слова про tools/workspace/файлы.
- File: `apps/backend/src/common/zen/session-runner.service.ts` (197–320) — `chat()`: находит ключ (`opencode_key_missing` 404 если нет), `chatModelGuard`, собирает `messages=[{system?},{user}]`, сначала `chatStream` (SSE `choices[0].delta.content`), fallback plain POST на `ZEN_CHAT_URL=https://opencode.ai/inference/openai/v1/chat/completions` с телом `{model, messages}` — **поля `tools`/`tool_choice` нет вообще**. Возвращает `string` (текст). Подтверждено: Zen-transport tool-кадров не производит.
- File: `apps/backend/src/common/zen/jev.service.ts` (134–250) — `classify()`: SystemOne POST `{model: JEV_ROUTE_MODEL, state, questions:{route:{type:'choice', criteria:{backend,frontend,fullstack,ask}}}}`, confidence-гейт `ROUTE_MIN_CONFIDENCE`, иначе `fallback()` → `heuristicRoute()`. Никогда не бросает. Для `напиши Hello World` вероятен route=backend/fullstack/ask — надо логировать, но в любом случае дальше текстовый executor.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` (408–667) — `sendMessage()`: (1) `tryProjectFileCommand` — парсит только явные команды `создай файл|create file|прочитай|read|выполни|run|shell:` через `parseCreateFileCommand/parseReadFileCommand/parseShellCommand`, пишет через `WorkspacePathService` jail или `host.sessionShell`; (2) иначе `sendMessageDirect` при наличии runner, иначе `sendMessageViaHost`. `sendMessageDirect`: `agents.askQuestion(agentId,...)` → текст → `history.appendMessage` + `bufferDirectFrames` (режет текст на `message.part.delta` чанки 200 + `message.part.updated` с `{part:{id,type:'text',text}}`) + `bufferDirectIdle` + лог `prompt answered directly`. **Никакого парсинга tool-кадров, никакого write/edit вызова.** `toStreamFrame`/`recordHostEvent`/`resolveHostBinding` обслуживают только host-путь (`session.text.delta/ended`, `session.step/execution.*`), direct-путь их не трогает.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/sessions.service.ts` — тонкий фасад к харнессу, транспорта нет.
- File: `apps/backend/src/processes/modules/ai/modules/opencode/opencode-host.service.ts` (105–189) — host умеет `sessionCreate/sessionPrompt/sessionShell`: т.е. файловые операции возможны через host-путь (`sendMessageViaHost` + `tryProjectFileCommand`), но direct-путь (при наличии ключа) их обходит.
- File: `apps/frontend/src/hooks/useChat.ts` (124–275, 472–508) — `frameText` понимает `session.text.delta/ended` + `message.part.delta/updated`; `frameToolName` отвечает только на `message.part.updated` с НЕ-текстовым part (`tool/toolName/name`), текст возвращает null. Direct-буфер шлёт только текстовые part → `toolTrace` всегда пуст, `activeToolName` null. Timeline пуст — совпадает с симптомом «tool-timeline не виден».
- File: `apps/frontend/src/components/chat/chat-window/chat-tools-timeline.tsx` — рендерит `toolTrace` + live tool; при пустом — `toolsEmpty`.
- File: `packages/contracts/src/` — разбивка `session/sessions/opencode-session/opencode-event/...`; `sessions.dto.ts` несёт `agentIdSchema` — контракт агентов на месте.
- Pattern: backend AGENTS.md — fail-fast без тихих фолбэков, `REPOS_ROOT` единственный корень, fs только через `WorkspacePathService`, логи только `AppLogger`, DI `private readonly`, uuid только `Bun.randomUUIDv7()`.

## Decisions
- Decision: гипотеза Epoch 1 подтверждена на 4/5 слоёв: промпт без tools + Zen chat без tools + harness без исполнения + фронт без tool-кадров.
- Alternatives considered: винить только фронт (не показывает approve) — отвергнуто: кадров нет уже на бэке.
- Rationale: чинить надо бэк-цепочку исполнения, фронт — только индикатор.

## Confirmed Plan Items
1. Диагностика обязана доказать каждый слой отдельно (промпт/транспорт/харнесс/SSE) — reason: иначе фикс промахнётся; artifact: e2e repro-лог; validation: повтор `Hello World`.
2. Фикс обязан сохранить ask readonly — reason: критерий задачи; artifact: регресс-тест ask; validation: ask не создаёт файлов.

## Open Questions
- Какой route даёт Jev на `напиши Hello World на NodeJS` — backend или ask? (влияет на выбор executor, но не на корень: оба текстовые).
- Есть ли у Zen Inference API поддержка OpenAI `tools` (надо сверить с docs через context7 / CLI `text.ts extractCloudText`)?
- Должен ли auto исполнять через host `sessionPrompt` (у которого есть файлы/шелл) вместо direct Zen chat, или добавить tools в direct-путь?

## Next Epoch Focus
- Превратить находки в решения: выбрать стратегию исполнения (A: host-путь, B: tools в Zen, C: парсер file-команд в auto), зафиксировать конфликты и границы контрактов.
