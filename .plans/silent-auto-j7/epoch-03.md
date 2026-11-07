# Epoch 3: Decision foundation — куда чинить

## Hypothesis
Корень — отсутствие исполнения: auto генерирует текст-план, но не вызывает мутаций. Три кандидата-стратегии.

## Evidence Found
- Pattern: `tryProjectFileCommand` уже умеет jailed write/read/shell, но срабатывает только на дословные команды (`создай файл X`), а не на произвольный auto-шаг (`напиши Hello World` → decompose → «1. Создай package.json…» внутри LLM-текста, не в `body.text`).
- Pattern: host-путь (`sendMessageViaHost` → `host.sessionPrompt`) отдаёт выполнение embedded OpenCode (у него есть workspace + tools + SSE `session.text.*` + `message.part` tool-frames), а direct-путь (`SessionRunnerService.chat`) — голый LLM-текст.
- Pattern: транспорт выбирается по наличию ключа: ключ есть → direct (текст), ключа нет → host (исполнение). Т.е. при настроенном ключе auto **гарантированно** идёт текстовым путём — объясняет «zen 450мс ok, но файлов нет».
- Conflict 1: если переключить auto на host всегда — теряется per-user Zen billing/key изоляция и direct-streaming; если оставить direct — нужно достраивать tools.
- Conflict 2: добавление OpenAI `tools` в `SessionRunnerService.chat` меняет сигнатуру кросс-доменного `common/zen` (AGENTS.md: `common/` не знает о доменах) — инструменты надо класть в `common/storage`-совместимый слой, а не в доменный.
- Conflict 3: фронт `frameToolName` ждёт НЕ-текстовые `message.part.updated`; direct-буфер таких не шлёт — контракт SSE надо расширять, но `contracts sessions.schema` заморожен (back-compat, sessions.service doc).

## Decisions
- Decision D1: стратегия — **A (host-исполнение для auto) как primary, B (tools в direct) как follow-up**. Auto с мутациями идёт через bound host session (уже умеет файлы/шелл/снапшоты/revert), direct Zen остаётся для ask/чтения. Rationale: минимальный риск, переиспользует `captureTurnSnapshot`, jail, recorder; не требует нового tool-протокола в `common/zen`.
- Alternatives considered: B — добавить `tools:[writeFile,readFile,shell]` в `chat()` + executor-loop в `AutoAgent.runChain` — мощнее, но трогает `common/zen`, требует approve-UX, permission-гейты, маппинг tool-кадров в SSE; C — парсить шаги auto регэкспом и выполнять как file-команды — хрупко, LLM-формат нестабилен. Отложены/отвергнуты для первой итерации.
- Decision D2: ask остаётся строго readonly (direct, без host-переключения) — non-negotiable из критериев.
- Decision D3: SSE-контракт не ломаем: host уже эмитит нужные frames; direct-буфер не меняем в первой итерации, только добавляем `session.idle` (уже есть) + логи.
- Decision D4: диагностика первична — 2 карточки repro до фикса.

## Confirmed Plan Items
1. CARD-1 repro direct vs host (бэк) — reason: доказать ветвление по ключу; artifact: лог route+transport+ФС; validation: Hello World без файлов на direct, с файлами на host.
2. CARD-2 трассировка SSE/timeline (фронт) — reason: доказать пустоту toolTrace на direct; artifact: скрин/лог frames; validation: timeline пуст на direct, непуст на host.
3. CARD-3 фикс маршрутизации auto→host — reason: D1; artifact: код + спеки; validation: критерии приёмки.
4. CARD-4 регресс ask + идемпотентность — reason: D2 + критерий; artifact: e2e; validation: ask без файлов, повтор auto без дублей/падений.

## Open Questions
- Точный флаг выбора: `agentId==='auto'` всегда в host, или только когда шаги содержат мутации? (нужен эвристический детектор vs всегда-host).
- Нужен ли approve перед host-исполнением (permission.asked без UI висит — из подозрений)?
- Куда писать hello-node: `content/` jail проекта vs корень workspace? (`resolveProjectDirectory` + `WorkspacePathService` — уточнить в Epoch 4).

## Next Epoch Focus
- Развернуть карточки в файлы/чек-листы/complexity-риск, уточнить jail-пути, снапшоты, SSE-фильтры, gating approve.
