# Epoch 4: Refinement — карточки, файлы, границы

## Hypothesis
D1 (auto→host) реализуем минимальным диффом в харнессе + явным системным промптом, без ломки контрактов.

## Evidence Found
- File: `session-harness.service.ts:408-443 sendMessage()` — точка ветвления: `tryProjectFileCommand → runner? sendMessageDirect : sendMessageViaHost`. Сюда встанет гейт `shouldUseHost(agentId, text)`.
- File: `session-harness.service.ts:582-667 sendMessageDirect()` — читает `getAgent/setAgent`, пишет receipt до вызова агента, `captureTurnSnapshot(directory, sessionId, receipt.id)`. Host-путь `719-780` делает то же + `recordTurnStart` + `ensureAssistantRecorder` до prompt. Оба снапшотят — revert-совместимость сохранится при переключении.
- File: `session-harness.service.ts:964-977 toStreamFrame()` + `989-1181 streamEvents()` — project-scoped `resolve()`, фильтр `localSessionIds`, replay по cursor. Host-frames уже re-keyed; переключение auto на host автоматически даст timeline без фронта-изменений.
- File: `agents.registry.ts:68-77 resolve()` — unknown id → fallback ask (не 500). `agents.service.ts:30-44 askQuestion` — только ask/auto callable, 404 иначе. Гейт `resolveAgentId` в харнессе уже даёт честный 404.
- File: `apps/backend/src/common/storage/workspace-path.service.ts` (имя из конструктора харнесса) — jail-примитивы `readFile/writeFile/ensureDir`; `jailFile()` в харнессе — лексический jail (`path.resolve` + prefix-check, 403 на escape). Писать только через него, `REPOS_ROOT` — корень (AGENTS.md fail-fast, без `cwd/repos`).
- File: `apps/frontend/src/hooks/useChat.ts:193-275 frameToolName/toolTrace` — без изменений в первой итерации; CARD-2 только наблюдает.
- Boundary: `common/` — один `@Global()` модуль, новых `*.module.ts` в подпапках нельзя; DI — `private readonly`; uuid — `Bun.randomUUIDv7()`; логи — `AppLogger` однострочники, без секретов/стеков в normal path.

## Decisions
- Decision: карточки 5 шт (2 диагностика + 2 фикс + 1 проверка). Оценка complexity/риска ниже — в PLAN.md.
- Decision: гейт первой итерации — **явный**: `agentId==='auto'` + наличие ключа НЕ уводит в direct; ask/не-auto без изменений. Эвристику «мутация vs вопрос» не строим (хрупко) — вместо этого auto всегда host, ask всегда direct. Supersedes open question Epoch 3 (флаг): выбрано всегда-host для auto.
- Decision: approve-UX первой итерации — нет нового модала; host-исполнение идёт в уже-созданной сессии проекта (пользователь уже санкционировал сессию), jail + snapshots + interrupt сохраняются. Отдельная карточка follow-up на permission-гейт.
- Decision: hello-node артефакты — в gated project `directory` (тот же `directory`, что `create()` передаёт в `host.sessionCreate`), файлы `hello.js/src/*`, `package.json`, тест; идемпотентность — повторный промпт перезаписывает тем же содержимым, не дублирует.

## Confirmed Plan Items
1. CARD-1 `diag-direct-vs-host` — файлы: harness service, runner, host, jev; чек-лист: repro с ключом/без ключа, лог route/transport/ФС.
2. CARD-2 `diag-sse-timeline` — файлы: useChat.ts, chat-tools-timeline.tsx, contracts opencode-event/session; чек-лист: записать frames обоих путей, подтвердить пустоту toolTrace на direct.
3. CARD-3 `fix-auto-to-host` — файлы: session-harness.service.ts (+__tests__), sessions.dto (если нужен флаг), e2e; чек-лист: гейт, снапшот, recorder до prompt, логи, lint/build.
4. CARD-4 `fix-auto-prompt-harden` — файлы: auto.agent.ts, backend/frontend/fullstack agents; чек-лист: system-промпт требует файловые результаты + honest-fallback, UNCLEAR без изменений.
5. CARD-5 `verify-acceptance` — e2e Hello World + ask-регресс + идемпотентность + interrupt; чек-лист: критерии Done.

## Open Questions
- Нужен ли `body.model/agent` проброс в host prompt (сейчас `void body.model`, model pinned at create) — оставить как есть в итерации 1.
- Точный список hello-node файлов (hello.js vs src/index.js) — зафиксировать в PLAN.md Done-критерии (выбрано: `hello.js + package.json + test` минимум).

## Next Epoch Focus
- Валидация: прогнать план через conflict-check, complexity/риск-матрицу, контракт-фріз, тестовую стратегию; собрать финальный PLAN.md + evolution-log.md.
