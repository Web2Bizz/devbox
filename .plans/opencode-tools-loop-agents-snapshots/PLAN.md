# План переноса opencode → rush-code: инструменты, циклы, агенты, снапшоты, откат, форк, revert messages

Локальный план, без Trello, в текущей ветке. Порядок — по зависимостям, каждый шаг驗證ется перед следующим.
Донор: `/media/codebase/@letnull19a/opencode` (v2.2.5). Опора: `.tmp/opencode-overview.md`.
Не дублирует `.plans/`: `agent-harness-prototype`, `ai-chat-stream-model`, `ai-stream-model`, `backend-domain-restructure`, `iron-branch-v1`, `opencode-sdk-migration`, `org-only-lynx-42`, `password-service`.

## Что НЕ портируем

Effect-слои/Bus/State, Hono-server, Solid/TUI/app/desktop, SDK/client-генерат, plugin-host, MCP-browser, Rust PTY-демон, httpapi-codegen/recorder/simulation, Astro web, Electron, PTY/schedule/image/mcp-resource (2-я очередь).

## Куда что ляжет (scope-правила)

- `packages/contracts` — только типы + zod v4 boundary-схемы, зеркало `contracts/openapi.yaml` поле-в-поле (YAML правится первым). Рантайм-логики нет.
- `apps/backend` — слои `processes/ → organizations/ → common/` (стрелка вниз); `common/` — один `@Global()`, новых `*.module.ts` в подпапках нет; вложенность только `<parent>/modules/<sub>/`; тесты `__tests__/` рядом (`*.spec.ts`/`*.e2e.ts`); логи только `AppLogger` однострочники без секретов/стеков; `REPOS_ROOT` единственный корень (fail-fast 503/500, без fallback на cwd); uuidv7 — `Bun.randomUUIDv7()`; DI `private readonly`.
- `apps/frontend` — `app/` тонкая композиция; логика в `src/features/` + `src/hooks/`; data только React Query, ключи только `query-keys.ts`; fetch только `src/api/client.ts` (`request()`), домен — `sessions-client.ts`; SSE — `useEffect`-исключение с комментом; запрет `@opencode-ai/sdk` и `/api/opencode/*` (guard `no-opencode-transport.test.ts`).
- `apps/cli` — не трогаем (существующий `src/agents/opencode/` уже ходит через backend API).

## Этапы (строго по порядку)

### 0. Контракты (база всего)
- `contracts/openapi.yaml`: `components/schemas` + paths:
  - `SessionForkRequest { before?: string }`, `SessionForkResponse { session: SessionInfo, boundary: { type: 'before'|'through', messageID: string } }`
  - `RevertStageRequest { messageID: string, files?: boolean }`, `RevertInfo { messageID: string, snapshot: string|null, files: SnapshotDiff[] }`, `SnapshotDiff { file: string, hunks?: string }`
  - `ToolCallInfo { id, name, namespace?, result }` (для таймлайна; в историю как часть SessionMessage — без ломки `text`-null конвента)
  - paths: `POST /api/v1/sessions/{id}/fork`, `POST /api/v1/sessions/{id}/revert/stage`, `DELETE /api/v1/sessions/{id}/revert`, `POST /api/v1/sessions/{id}/revert/commit`, `GET /api/v1/sessions/{id}/snapshots/diff?from&to`.
- `packages/contracts/src/sessions/sessions.ts` — типы; `sessions.schema.ts` — zod-схемы (ошибки в стиле `Field "x" is required`); `index.ts` — реэкспорт.
- Проверка: `bun run lint`, `bun run test` в `packages/contracts`.

### 1. Backend: инструменты (MVP-8)
- Новый `apps/backend/src/processes/modules/ai/modules/tools/`:
  - `tool-registry.service.ts` — регистрация по имени (`name` / `namespace.name`), листинг для промпта.
  - `tool-dispatch.service.ts` — семантика донора `dispatch/runTools`: unknown-tool → error-result (не исключение), invalid-JSON → error-result с retry-текстом, порядок результатов = порядку вызовов, `concurrency` bounded (не unbounded — защита NestJS).
  - `tools/read.tool.ts`, `write.tool.ts`, `edit.tool.ts`, `glob.tool.ts`, `grep.tool.ts`, `shell.tool.ts` (jail + allowlist + timeout, без PTY), `patch.tool.ts`, `todo.tool.ts` — все fs только через `WorkspacePathService` (common/storage), escape → отказ.
- 2-я очередь (не в MVP): `webfetch/websearch/skill/subagent-question/schedule/image/mcp-resource`.
- Проверка: `__tests__/tool-dispatch.spec.ts` (unknown, invalid-input, outside-jail, order).

### 2. Backend: цикл (loop + runner)
- Чистые функции `.../sessions/modules/runner/loop.ts`: `pendingCalls` (answerTool терминален, `length`-finish терминален, invalid-JSON → replay-call), `nextRequest` (forced toolChoice только первый шаг), `stepMessages`, `addUsage`, `collect` (fold step-start/step-finish/tool-result/finish; финал без finish → ошибка incomplete-stream).
- Раннер `.../sessions/modules/runner/runner.service.ts`: step → dispatch → nextRequest; `max-steps.ts` лимит, `retry.ts` bounded (без бесконечных), prompt-сборка, публикация SSE-кадров (`message.part.delta`, `session.step.ended` — имена уже в контракте SSE).
- Интеграция в `SessionHarnessService` (create/send/interrupt/status не меняют сигнатур; SessionsService остаётся thin facade).
- Проверка: unit fold/usage; e2e send → дельты → `session.step.ended`; stop = abort + interrupt + partial + drop кадров.

### 3. Backend: агенты
- Расширить `apps/backend/src/processes/modules/ai/modules/agents/`:
  - registry `resolve(id?)/select(id?)/list()` — default `build`, фильтр `hidden` и `mode==='subagent'` из селекта (как донор), id-паттерн `agentIdSchema` уже в contracts.
  - `subagent-job.service.ts` — сабагент как инкапсулированный job (вход/выход через ToolSettlement, без прямого доступа к транспорту).
  - Существующие `ask/auto/backend/frontend/fullstack` — зарегистрировать в registry, не плодить контроллеры.
- Проверка: `agents.controller.security.spec.ts` зелёный; resolve unknown → default, не 500.

### 4. Backend: снапшоты + revert + fork
- `.../sessions/modules/snapshots/snapshots.service.ts` — семантика донора `snapshot.ts` на git под REPOS_ROOT: `capture()` best-effort (`undefined` если не-git/disabled/fail + warn-лог без тела), `files(from,to)`, `diff(from,to,context?,paths?)`, `restore(files)` строгий (escape → ошибка, disabled → ошибка). Discover через `git rev-parse`, отдельное snapshot-хранилище вне worktree. Без pack-оптимизации и 2МБ-лимита в MVP.
- `.../sessions/modules/revert/revert.service.ts` — `stage(session,messageID,files?)` (boundary seq lookup → MessageNotFound, plan по assistant seq>boundary со snapshot.start, restore, diff, сохранить staged в harness-состоянии), `clear` (restore original), `commit` (фиксация, очистка staged). Ошибки маппить в `EXTERNAL_*` → `ApiError` envelope (+`x-correlation-id`), как весь backend.
- `SessionHarnessService.fork(sessionID, before?)` — boundary lookup (нет + before → MessageNotFound; нет без before → ForkEmpty), новая сессия `Bun.randomUUIDv7()`, копирование сообщений до boundary (through — включительно, before — строго до), инструкции — newest-values (как донор), media-blob в MVP не копируем (только текст+tool-история).
- `sessions.controller.ts` — 5 эндпоинтов из §0, каждый: JwtAuthGuard → `assertProjectAccessById` → jail → harness → envelope. SSE-события `revert.staged/cleared/committed`, `session.forked` — как `data: Record` во `SessionStreamFrame` (narrowed-схемы при нужде).
- Проверка: e2e — fork до before/through → messages совпадают; stage → diff непуст → clear возвращает файлы → commit чистит staged; не-git проект → capture undefined, restore 503.

### 5. Frontend
- `src/api/sessions-client.ts`: `forkSession(id, before?)`, `stageRevert(id, messageID)`, `clearRevert(id)`, `commitRevert(id)`, `snapshotDiff(id, from, to)` — поверх `request()`, парсинг новыми zod-схемами; SSE-слушатели новых типов в существующем `streamSessionEvents`.
- `src/hooks/` (ключи только в `query-keys.ts`): `useForkSession`, `useRevert` (stage/clear/commit мутации + invalidate), `useSnapshotDiff`.
- `src/features/chat/` + `src/components/chat/`: кнопка Fork на сообщении (before/through выбор), revert-диалог (превью diff → Commit/Discard), tools-таймлайн в `chat-message` (ToolCallInfo), статусы busy/idle уже есть.
- Проверка: `bun run lint`, `bun run build`; guard `no-opencode-transport.test.ts` зелёный (новых импортов SDK нет).

### 5.1. Frontend-чат live-статусы (idle/busy, active agent, active tool call)

Принцип: фронт следует за функциями бэкенда (contracts → backend → frontend, не наоборот). Никаких новых endpoint/fetch/ключей ради статуса — только сузить и показать то, что уже течёт по `GET /api/v1/sessions/events` + `GET /api/v1/sessions/status`. Порядок работ: сначала contracts (§0 стиль), потом backend-форвард, потом фронт-рендер.

Конвенции (обязательно): `export type` без `interface`; timestamps только ISO-8601 `string` + `z.iso.datetime()`; массивы только `Array<T>`; полные имена без аббревиатур (`activeAgentId`, `activeToolName`, `toolTrace` — уже ок, `msg/err/req/res/idx` запрещены). Backend: структура домена controller/service/dto/repository, чистые функции — только `utils/<name>/` с `index.ts` + `__tests__/`, тесты только в `__tests__/`, DI `private readonly`, логгер `new AppLogger(ClassName.name)`.

#### Что уже есть (reuse-first, менять это)

- `apps/frontend/src/api/sessions-client.ts` — `sessionEventStream()` уже парсит каждый кадр через `sessionStreamFrameSchema` (fail-loud, heartbeat-строки без `data:` скипаются); `getSessionStatuses()` + `listAgents()` уже есть. Новых fetch-функций НЕ создавать.
- `apps/frontend/src/hooks/query-keys.ts` — `sessionStatusQueryKey` (busy/idle map) и `agentsQueryKey` уже есть. Новых ключей НЕ создавать.
- `apps/frontend/src/hooks/useChat.ts` — `frameText()` уже различает `session.text.delta` / `session.text.ended` / `session.execution.succeeded|failed|interrupted` / `session.step.ended` / `message.part.delta(updated)` / `session.idle`, `sendingRef` уже глушит кадры после `stop()`, `toolTrace: Array<ChatToolEvent>` уже append-only. Расширять это, не дублировать.
- `apps/frontend/src/components/chat/chat-window/chat-window.tsx` — ветки loading/error/empty + `thinking = sending && !streamingText` + `data-testid="chat-thinking" / "chat-streaming-status"` + `aria-busy` + `ShimmerText` уже есть.
- `apps/frontend/src/components/chat/chat-window/agent-thinking.tsx` — ротация `t.chat.thinking` через `ShimmerText` уже есть. Принять пропсы, не создавать новый компонент.
- `apps/frontend/src/components/chat/chat-window/chat-tools-timeline.tsx` — `ChatToolsTimeline` под скроллером уже есть (история доменных вызовов). Живой tool-call — туда же live-строкой, не новым виджетом.
- `apps/frontend/src/components/chat/agent-selector/agent-selector.tsx` — показывает `agentId` (`DEFAULT_AGENT_ID = 'ask'`, сервер дефолтит так же). Активный агент при `sending` — read-only отображение этого же значения.
- `apps/backend/.../sessions/session-harness.service.ts` — `toStreamFrame()` уже passthrough любых host-кадров (id/type/data + hoisted `session`), `statusMap()` уже отдаёт busy/idle из `busyDirect`, `bufferDirectIdle()` шьёт `session.idle`, `recordHostEvent()` уже видит `session.text.*` / `session.step.ended` / `session.execution.*`. Форвардить, не изобретать типы.
- `packages/contracts/src/sessions/` — `SessionStreamFrame`, `SessionMessagePartDeltaFrame`, `SessionMessagePartUpdatedFrame`, `SessionInfo.agentId`, `AgentInfo`, `SessionRunStatusMap` уже есть.

#### Слушать (существующие SSE-кадры, ничего не выдумывать)

1. `session.idle` + `session.step.ended` + `session.execution.succeeded|failed|interrupted` → переход busy→idle (уже финализирует `sending`; показать бейджем, а не новой сущностью).
2. `session.text.delta` / `session.text.ended` (`data.delta`/`data.text`) → идёт стрим (уже в `frameText`; статус «стримим» остаётся).
3. `message.part.delta` (`field === 'text'`, safeParse через `sessionMessagePartDeltaFrameSchema`) / `message.part.updated` (`part.type === 'text'`, safeParse через `sessionMessagePartUpdatedFrameSchema`) — как сегодня, без кастов.
4. Активный tool-call: `message.part.updated` с не-текстовым `part` (variant-owned passthrough — читать только typeof-гвардами, envelope уже доказывает `part: Record<string, unknown>`), либо уже текущие host-типы из шины (что реально эмитит раннер — то и показать; имена типов берутся из `contracts/opencode-stand-2.2.0.json eventFrames.usedVariants`, не придумываются). Маппинг имени инструмента — чистая функция, не новый сервис.
5. Активный агент: `SessionInfo.agentId` + per-turn override `SendMessageRequest.agentId` (состояние `useChat.agentId`, уже есть) + registry `GET /api/v1/agents` (`AgentInfo`). Отдельный «agent-switched» кадр — только если такой тип реально есть на шине host (тогда тоже safeParse-нарождённой схемой, иначе — effective agent текущего turn).

#### Zod-схемы (переиспользовать, добавлять только contracts-first)

- Переиспользовать: `sessionStreamFrameSchema` (envelope), `sessionMessagePartDeltaFrameSchema`, `sessionMessagePartUpdatedFrameSchema`, `sessionRunStatusMapSchema`, `agentInfoListSchema`, `agentIdSchema`.
- Новые narrowed-схемы (если вариант host стабилен, напр. tool-call/agent-transition) — только так: сначала `contracts/openapi.yaml` `components/schemas` поле-в-поле, затем `packages/contracts/src/sessions/sessions.ts` (`export type`, `Array<T>`, `createdAt: string` + ISO-док) + `sessions.schema.ts` (`z.iso.datetime()`, ошибки в стиле `Field "x" is required`), реэкспорт в `index.ts`; backend `sessions.dto.ts` — реэкспорт (`export { … } from '@rush-code/contracts'`), фронт — `import type` + safeParse. Проверки: `bun run lint/test` в `packages/contracts`, YAML↔пакет совпадают.
- Что НЕ создавать: новые REST-пути ради статуса (хватает `GET .../events` + `GET .../status`), новые `client.ts`-методы, новые query-keys, новые сторы, polling вместо SSE (SSE остаётся `useEffect`-исключением с комментом), `interface`, `T[]`, `Date/number`-timestamps, сокращённые идентификаторы.

#### Менять (конкретные файлы, без новых сущностей)

Backend (первым, фронт ждёт frozen-контракт):
1. `apps/backend/.../sessions/session-harness.service.ts` — расширить `recordHostEvent`/`toStreamFrame` форвардом уже существующих agent/tool-переходных кадров host-шины (без изобретённых типов; неизвестное — passthrough как сегодня); `statusMap` остаётся источником busy/idle. Чистый маппинг имени инструмента — в `.../sessions/utils/<name>/` (`<name>.util.ts` + `index.ts` + `__tests__/<name>.spec.ts`), не в сервисе.
2. `apps/backend/.../sessions/sessions.dto.ts` — реэкспорт новых narrowed-схем (если появились); контроллер без новых маршрутов (`GET .../events`, `GET .../status`, `POST .../interrupt` уже покрывают).

Frontend (после backend, поверх его функций):
3. `apps/frontend/src/hooks/useChat.ts` — расширить `frameText()` + состояние `activeAgentId: string | null` / `activeToolName: string | null` (деривация из кадров п.4–5 выше, сброс в `finalize()`/`stop()`/смене сессии вместе с `resetStream()`; `sending` остаётся busy-сигналом; `sessionStatusQueryKey`-map из `useSessions` — для бейджа вне активного чата, не дублировать в `useChat`).
4. `apps/frontend/src/features/chat/chat-section.tsx` — только пробросить новые поля `useChat` (`activeAgentId`, `activeToolName`) в `ChatWindow`; логики не добавлять (тонкая композиция).
5. `apps/frontend/src/components/chat/chat-window/chat-window.tsx` — статусная строка под стриминг-пузырём / вместо `thinking`: `idle` (история, тихо) vs `busy: <agent> [, tool: <name>]` через существующий `ShimmerText` + `aria-busy`, `data-testid` расширить рядом с `chat-streaming-status`/`chat-thinking`.
6. `apps/frontend/src/components/chat/chat-window/agent-thinking.tsx` — принять `activeAgentName?: string, activeToolName?: string` и показать «агент • инструмент» вместо голой ротации, пока `sending && !streamingText`; ротацию фраз оставить как fallback.
7. `apps/frontend/src/components/chat/chat-window/chat-tools-timeline.tsx` — live-строка текущего tool-call (тот же `ChatToolEvent`, `kind: 'sse'`, label из чистой функции п.Backend-1) поверх append-only истории; отдельный виджет не создавать.
8. `apps/frontend/src/components/chat/agent-selector/agent-selector.tsx` — при `sending` показать активное значение read-only (`disabled` уже есть).
9. `apps/frontend/src/i18n/dictionaries/{en,ru}.ts` + `types.ts` — строки `t.chat` расширить (`activeAgent`, `activeTool`, `idle`, `busy`), новый namespace не заводить.
10. Тесты рядом с меняемым: `src/hooks/__tests__/useChat.test.tsx` (кадры tool/agent → состояние → сброс на idle/stop), `src/components/chat/__tests__/chat-window.test.tsx` (бейджи idle/busy/tool), guard `src/__tests__/no-opencode-transport.test.ts` зелёный.

#### Проверка 5.1

- `bun run lint`, `bun run build` (frontend), `bun run lint/test` (contracts при новых схемах); e2e `sessions` + interrupt зелёные; `stop()` по-прежнему коммитит partial и глушит кадры (`sendingRef`-гард не сломан); секреты/тела команд не в логах и не в `toolTrace.detail`.
- Критерий: при занятом turn чат показывает какой агент отвечает и какой tool-call активен сейчас, в idle — тихо; всё парсится contracts-схемами, YAML↔пакет совпадают, новых импортов SDK/`/api/opencode/*` нет.

### 5.2. DESIGN-привязка (рефера DESIGN.md + apps/frontend/DESIGN.md)

Источники правды: корень `DESIGN.md` (общие принципы: кит — источник правды,
токены вместо хардкода, минимальный дифф, `radius(child)<radius(parent)`, запреты
декора, плоский контент, токены только в точке темы, i18n en/ru, плоские URL, a11y
через кит, ошибки штатным компонентом, владелец — человек approve) и
`apps/frontend/DESIGN.md` (§1 порядок стилей, §2 токены, §4/§4.1 радиусы и запреты
декора, §6 бренд, §7 плоский Content). При расхождении правит приложенческий
`apps/frontend/DESIGN.md`. Читать оба перед правками UI §5/5.1; правила ниже —
применение гайда к fork/revert/tools/agent-статусам, reuse-first: менять
существующие `chat-window.tsx` / `agent-thinking.tsx` / `chat-tools-timeline.tsx` /
`chat-message.tsx` / `chat-section.tsx` / `agent-selector.tsx`, кит не дублировать.

1. **Плоский список, без карточек-в-карточках (§7 корня + §7 web).** Live-статусы
   (`idle` тихо / `busy: <agent> [, tool: <name>]`), fork/revert-контролы,
   tools-таймлайн — это строки/бейджи/кнопки inline, НЕ `Card`-обёртки:
   - active agent/tool — строка под стриминг-пузырём / вместо `thinking`
     (`chat-window.tsx`), как сегодня `ShimmerText` после ghost-пузыря;
   - tools-таймлайн — существующий плоский `Collapsible` + `ol/li` строки
     (`chat-tools-timeline.tsx`), live-строка — тот же `li` с `ShimmerText`,
     не новый виджет и не `Card`;
   - кнопка Fork — inline в `MessageFooter` рядом с like/dislike-туглами
     (`chat-message.tsx`), без обёртки;
   - fork/revert-диалог — китовый `Dialog` (контент: заголовок секции `h2` +
     `p.text-muted-foreground`, плоский `ol/li` diff-строк, `Separator`,
     `Badge` файла/статуса, `Button` Commit/Discard inline), сам диалог —
     системный примитив кита, а не «карточка в карточке»;
   - пустое состояние diff/таймлайна — плоский `Empty`/`p.text-muted-foreground`
     (`toolsEmpty`-паттерн), без `Card`/`border`/`background`;
   - ошибки revert/fork — штатный `ErrorState` / `Alert variant="destructive"`
     (`states.tsx`), бордер/фон разрешены только как системному сообщению
     об ошибке.
2. **Радиусы по шкале (§4 web, принцип `radius(child)<radius(parent)`).**
   Чат живёт внутри `.app-content` уровня 0 (`var(--radius-xl)`): статусные
   триггеры/кнопки — уровень 1 `var(--radius-md)` (образец — триггер
   `ChatToolsTimeline`: `rounded-[var(--radius-md)]`), вложенные бейджи/кнопки
   внутри диалога — уровень 2 `var(--radius-sm)` / `var(--radius-xs)`
   (чипы, счётчик `Badge`), глубокая вложенность — `var(--radius-xs)`.
   Запрещено: повторять радиус родителя, `radius: 0` в скруглённом контейнере,
   flatten-селекторы поверх кита.
3. **Токены вместо хардкода (§2 web + §1/§4 реферы).** Только `var(--…)` /
   kit-утилиты: текст `text-muted-foreground`, строки `bg-muted`, разделители
   `var(--border)`, фокус `outline-ring`. Hex/rgb-литералы — только `:root` /
   `.dark` в `app/globals.css`; в селекторах компонентов — magic-color
   (см. застарелый `.app-sidebar-overlay`-литерал, §2 web — не повторять).
   Образец — `chat-tools-timeline.tsx` (токенные классы, без hex).
4. **Ноль декора (§4.1 web + §3 реферы).** Для fork/revert/tools/agent-статусов:
   без `box-shadow` / `drop-shadow` / `filter: drop-shadow` (исключений нет);
   без `linear-gradient` (бренд-градиент — только `Button variant="primaryBrand"`
   / `.text-gradient-brand` логотипа, здесь не применять); без `transform` /
   `translate` / `scale` / `transition: transform` на блоках (hover — только
   `hover:bg-muted` + цвет текста, как триггер таймлайна; шеврон `▾`-поворот —
   декоративная трансформация, заменить статичным маркером или китовой иконкой
   без rotate-класса). Порядок стилей не менять
   (`@web2bizz/ui/styles.css` → `globals.css`).
5. **Компоненты из кита, a11y из коробки (§5 реферы + §6 web).** Fork/revert —
   китовые `Dialog` + `Button` + `Badge` + `Separator` (Esc/Tab-ловушка,
   фокус-ринг, `aria-*` — нативные, свои виджеты не дублируют механику);
   статусы — `ShimmerText` + `Badge variant="secondary"`; видимый фокус
   обязателен (`focus-visible:outline-2 outline-ring outline-offset-2`,
   как триггер таймлайна). Сохранить существующие контракты: `aria-busy` +
   `aria-label` на thinking-блоке, `aria-live="polite"` скроллера,
   `data-testid` рядом с `chat-streaming-status` / `chat-thinking` /
   `chat-tools-timeline` / `chat-tool-event`, `aria-expanded` на триггере,
   `role=log` скроллера — от кита. Live-строка tool-call — тот же
   `ChatToolEvent` (`kind: 'sse'`), новый namespace/стор не заводить.
6. **i18n en/ru, плоские URL.** Все строки fork/revert/tools/agent-статусов —
   в `t.chat` (`dictionaries/{en,ru}.ts` + `types.ts`: `activeAgent`,
   `activeTool`, `idle`, `busy`, `fork*`, `revert*`), новый namespace не
   заводить; переключатель языка/кука `rush-code-locale` уже есть. Статусы
   маршрутов не создают — URL остаются плоскими.
7. **Владение (§6 реферы).** DESIGN-правила меняет только человек approve +
   коммит; агент читает оба DESIGN перед правками и в описании указывает,
   какой пункт §5.2/§7/§4.1 затрагивает. Guard реестра (§3 web): новые
   компоненты fork/revert (если выносятся из `chat-message.tsx`) регистрировать
   в `apps/frontend/DESIGN.md` §3.2/§3.3, иначе guard сочтёт незарегистрированными.

### 6. Сквозная валидация
- `bun run lint`, `bun run build`, `bun run test` (корень + affected); точечные e2e `sessions`, `auth`; скан секретов в логах (эталон `keys.e2e.ts`); `graphify update .` после изменений кода.

## Зависимости (что за чем)

contracts(0) → tools(1) → loop(2) → agents(3) → snapshots/revert/fork(4) → frontend(5) → валидация(6). Параллелить нельзя: harness зависит от tools+loop, revert — от snapshots+history, frontend — от frozen-контракта.

## Критерии готовности

- Fork/revert/snapshot-diff ходят через `/api/v1/sessions*`, парсятся contracts-схемами, YAML↔пакет совпадают.
- Unknown-tool/invalid-input/outside-jail — error-result/отказ, не 500; логи без секретов/тел команд.
- e2e fork/revert/interrupt зелёные; guard-frontend зелёный; lint/build/test зелёные.

---

## Appendix Drafts — концептуальные черновики (не финальный код)

> Сырой материал для переноса. Всё reuse-first: ложится на существующее
> (`ai/modules/{agents,sessions}`, `packages/contracts/src/sessions/`,
> `apps/frontend/src/{api,hooks,features/chat}`). Конвенции: `export type` + `&`
> (без `interface`), `Array<T>` (без `T[]`), timestamps `string` ISO-8601 +
> `z.iso.datetime()`, полные имена без сокращений. Backend: `*.service.ts` /
> dto-реэкспорт / `utils/<name>/index.ts` / `__tests__/` / `private readonly` /
> `new AppLogger(ClassName.name)`.

### D1. Contracts — fork / revert / tool-call (packages/contracts/src/sessions/)

```ts
// sessions.ts — добавить к существующим SessionInfo/SessionMessage
export type SessionForkRequest = {
  projectId: string;
  before?: string; // messageID-граница; absent = fork всего треда
};

export type SessionForkBoundary = {
  type: 'before' | 'through';
  messageID: string;
};

export type SessionForkResponse = {
  session: SessionInfo;
  boundary: SessionForkBoundary;
};

export type SnapshotDiff = {
  file: string;
  hunks?: string;
};

export type RevertStageRequest = {
  projectId: string;
  messageID: string;
  files?: Array<string>;
};

export type RevertInfo = {
  messageID: string;
  snapshot: string | null;
  files: Array<SnapshotDiff>;
};

export type ToolCallInfo = {
  id: string;
  name: string;
  namespace?: string;
  result: string;
};
```

```ts
// sessions.schema.ts — зеркало openapi.yaml components/schemas поле-в-поле
export const sessionForkRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  before: z.string().min(1).max(200).optional(),
}) satisfies z.ZodType<SessionForkRequest>;

export const revertStageRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  messageID: z.string({ error: 'Field "messageID" is required' }).min(1),
  files: z.array(z.string().min(1)).optional(),
}) satisfies z.ZodType<RevertStageRequest>;

export const revertInfoSchema = z.object({
  messageID: z.string({ error: 'Field "messageID" is required' }).min(1),
  snapshot: z.string().nullable(),
  files: z.array(snapshotDiffSchema),
}) satisfies z.ZodType<RevertInfo>;

export const toolCallInfoSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  name: z.string({ error: 'Field "name" is required' }).min(1),
  namespace: z.string().optional(),
  result: z.string({ error: 'Field "result" is required' }),
}) satisfies z.ZodType<ToolCallInfo>;
```

```ts
// index.ts домена — реэкспорт (существующий паттерн sessions/index.ts)
export * from './sessions';
export * from './sessions.schema';
```

### D2. Backend tools — registry + dispatch (ai/modules/tools/)

```ts
// tools/tool-registry.service.ts
@Injectable()
export class ToolRegistryService {
  private readonly logger: AppLogger = new AppLogger(ToolRegistryService.name);
  private readonly tools = new Map<string, ToolHandler>();
  register(tool: ToolHandler): void {
    this.tools.set(tool.fullName, tool); // fullName = namespace.name | name
  }
  listForPrompt(): Array<ToolDefinition> {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }
  resolve(name: string): ToolHandler | null {
    return this.tools.get(name) ?? null;
  }
}
```

```ts
// tools/tool-dispatch.service.ts — семантика донора dispatch/runTools
export type ToolSettlement = {
  callID: string;
  name: string;
  result: string; // unknown-tool / invalid-JSON / outside-jail → error-result, не throw
};

@Injectable()
export class ToolDispatchService {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly workspacePath: WorkspacePathService,
    private readonly logger: AppLogger = new AppLogger(ToolDispatchService.name),
  ) {}
  async dispatch(
    calls: Array<ToolCall>,
    concurrency: number,
  ): Promise<Array<ToolSettlement>> {
    // порядок результатов = порядку вызовов; concurrency bounded (не unbounded)
  }
}
```

```ts
// tools/read.tool.ts — пример одного инструмента (write/edit/glob/grep/shell/patch/todo — так же)
export type ReadToolInput = { path: string };
@Injectable()
export class ReadTool implements ToolHandler {
  readonly fullName = 'read';
  async execute(input: unknown, projectDirectory: string): Promise<string> {
    const parsed = readToolInputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { path: string }';
    const resolved = this.workspacePath.resolve(projectDirectory, parsed.data.path); // escape → throw
    return readFile(resolved, 'utf-8');
  }
}
```

### D3. Backend loop — чистые функции (sessions/modules/runner/loop.ts)

```ts
// loop.ts — только чистые функции, без DI; тесты в __tests__/loop.spec.ts
export type LoopStep = {
  calls: Array<ToolCall>;
  finishReason: string | null;
};

export function pendingCalls(step: LoopStep): Array<ToolCall> {
  if (step.finishReason === 'length') return []; // length-финиш терминален
  return step.calls.filter((call) => call.name !== 'answerTool'); // answerTool терминален
}

export function nextRequest(step: LoopStep, stepIndex: number): StepRequest {
  return { toolChoice: stepIndex === 0 ? 'required' : 'auto' }; // forced только первый шаг
}

export function collect(frames: Array<SessionStreamFrame>): CollectedTurn {
  // fold step-start/step-finish/tool-result/finish; финал без finish → error incomplete-stream
}
```

```ts
// runner/runner.service.ts — оркестрация step → dispatch → nextRequest
@Injectable()
export class SessionRunnerService {
  constructor(
    private readonly dispatch: ToolDispatchService,
    private readonly logger: AppLogger = new AppLogger(SessionRunnerService.name),
  ) {}
  async runTurn(request: RunTurnRequest): Promise<CollectedTurn> {
    // max-steps лимит (max-steps.ts), bounded retry (retry.ts), публикация
    // SSE-кадров message.part.delta / session.step.ended
  }
}
```

```ts
// sessions/utils/tool-label/tool-label.util.ts + index.ts + __tests__/tool-label.spec.ts
export function toolLabel(callName: string): string { return callName; } // чистый маппинг имени
// index.ts: export * from './tool-label.util';
```

### D4. Backend agents — registry + subagent job (ai/modules/agents/)

```ts
// agents.registry.ts — поверх существующего AgentsService (ask/auto/backend/frontend/fullstack)
export type AgentResolveRequest = { agentId?: string };
@Injectable()
export class AgentRegistry {
  resolve(request: AgentResolveRequest): AgentDefinition {
    if (!request.agentId) return this.build; // default build
    return this.known.get(request.agentId) ?? this.build; // unknown → default, не 500
  }
  list(): Array<AgentDefinition> {
    return Array.from(this.known.values()).filter((agent) => !agent.hidden && agent.mode !== 'subagent');
  }
}
```

```ts
// modules/subagent/subagent-job.service.ts — сабагент как инкапсулированный job
@Injectable()
export class SubagentJobService {
  constructor(private readonly logger: AppLogger = new AppLogger(SubagentJobService.name)) {}
  async run(request: SubagentJobRequest): Promise<ToolSettlement> {
    // вход/выход через ToolSettlement, без прямого доступа к транспорту
  }
}
```

### D5. Backend snapshots + revert + fork (sessions/modules/{snapshots,revert}/)

```ts
// snapshots/snapshots.service.ts — семантика донора snapshot.ts на git под REPOS_ROOT
@Injectable()
export class SnapshotsService {
  constructor(private readonly logger: AppLogger = new AppLogger(SnapshotsService.name)) {}
  async capture(directory: string): Promise<string | undefined> {
    // best-effort: undefined если не-git/disabled/fail + warn-лог без тела
  }
  async diff(from: string, to: string, context?: number, paths?: Array<string>): Promise<Array<SnapshotDiff>> { ... }
  async restore(directory: string, files: Array<string>): Promise<void> {
    // строгий: escape → ошибка, disabled → ошибка
  }
}
```

```ts
// revert/revert.service.ts
export type RevertStageInput = { sessionID: string; messageID: string; files?: Array<string> };
@Injectable()
export class RevertService {
  constructor(
    private readonly snapshots: SnapshotsService,
    private readonly logger: AppLogger = new AppLogger(RevertService.name),
  ) {}
  async stage(input: RevertStageInput): Promise<RevertInfo> { /* boundary seq → MessageNotFound; plan по assistant seq>boundary; restore; diff; staged в harness */ }
  async clear(sessionID: string): Promise<void> { /* restore original */ }
  async commit(sessionID: string): Promise<void> { /* фиксация, очистка staged */ }
}
```

```ts
// session-harness.service.ts — fork (дополнение существующего toStreamFrame/statusMap/recordHostEvent)
async fork(sessionID: string, before?: string): Promise<SessionForkResponse> {
  // boundary lookup (нет + before → MessageNotFound; нет без before → ForkEmpty)
  // новая сессия Bun.randomUUIDv7(), копирование сообщений до boundary
  // (through — включительно, before — строго до), инструкции newest-values
}
```

```ts
// sessions.dto.ts — реэкспорт новых схем (паттерн §4 backend-CoC, как существующий файл)
export {
  revertInfoSchema,
  sessionForkRequestSchema,
  // ... остальные D1-схемы
} from '@rush-code/contracts';
```

### D6. Frontend — client + hooks + live-статусы (без новых ключей/endpoint-ов)

> DESIGN-рамка (§5.2 выше, рефера DESIGN.md + apps/frontend/DESIGN.md §4.1/§7):
> всё ниже — плоские строки/бейджи/кнопки inline, без `Card`-в-`Card`,
> без `box-shadow`/`linear-gradient`/`transform`, цвета/радиусы только
> `var(--…)` + kit-утилиты (`text-muted-foreground`, `bg-muted`,
> `rounded-[var(--radius-md)]` L1 / `var(--radius-sm-xs)` L2), компоненты —
> только кит (`Dialog`, `Button`, `Badge`, `Separator`, `ShimmerText`,
> `Collapsible`), ошибки — `ErrorState` / `Alert variant="destructive"`,
> строки — `t.chat` en/ru, a11y — нативные kit-примитивы (`aria-busy`,
> `aria-live`, `aria-expanded`, `data-testid`). Менять существующие
> `chat-window/agent-thinking/chat-tools-timeline/chat-message/chat-section/agent-selector`,
> кит не дублировать.

```ts
// src/api/sessions-client.ts — доменный фасад поверх request() (существующий withAuth)
export async function forkSession(sessionID: string, before?: string): Promise<SessionForkResponse> {
  return withAuth((token) => request(`sessions/${sessionID}/fork`, { method: 'POST', token, body: { before } }));
}
export async function stageRevert(sessionID: string, messageID: string): Promise<RevertInfo> { ... }
export async function clearRevert(sessionID: string): Promise<void> { ... }
export async function commitRevert(sessionID: string): Promise<void> { ... }
export async function snapshotDiff(sessionID: string, from: string, to: string): Promise<Array<SnapshotDiff>> { ... }
// SSE-слушатели новых типов — в существующем streamSessionEvents, новых fetch-функций ради статуса НЕТ
```

```ts
// src/hooks/useRevert.ts + useForkSession.ts + useSnapshotDiff.ts — только React Query + query-keys.ts
export function useRevert(sessionID: string | null, projectId?: string) {
  const queryClient = useQueryClient();
  const stage = useMutation({
    mutationFn: (messageID: string) => stageRevert(sessionID ?? '', messageID),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: sessionMessagesQueryKey(sessionID, projectId) }); },
  });
  return { stage, clear, commit }; // clear/commit так же, reload = invalidateQueries
}
// Ключи: sessionStatusQueryKey / agentsQueryKey уже есть — новых НЕ создавать.
```

```tsx
// useChat.ts — деривация live-статуса из уже текущих кадров (расширение frameText, не дублирование)
export type LiveStatus = {
  activeAgentId: string | null; // из SessionInfo.agentId + per-turn SendMessageRequest.agentId + AgentInfo
  activeToolName: string | null; // из message.part.updated не-текстовый part (typeof-гварды) — сброс в finalize()/stop()
};
// chat-window.tsx — busy: <agent> [, tool: <name>] плоской строкой через ShimmerText + Badge secondary + aria-busy,
// data-testid рядом с chat-streaming-status/chat-thinking; idle — тихо; без Card/border/background/shadow/transform.
// chat-tools-timeline.tsx — live-строка текущего tool-call тем же li (ChatToolEvent kind:'sse', label из чистой
// функции п.Backend-1, триггер rounded-[var(--radius-md)] уже ок), виджета нового нет; шеврон без rotate-класса.
// agent-thinking.tsx — пропсы activeAgentName?: string, activeToolName?: string, ротация как fallback (ShimmerText).
// agent-selector.tsx — при sending read-only (disabled уже есть).
// fork-кнопка — inline в MessageFooter chat-message.tsx рядом с feedback-туглами (kit Button/Toggle, без обёртки).
// revert/fork-диалог — китовый Dialog: h2 + p.text-muted-foreground, плоский ol/li diff + Separator + Badge,
// кнопки Commit/Discard kit Button inline; пусто — плоский Empty/p.text-muted-foreground; ошибка — ErrorState/Alert destructive.
// i18n: t.chat расширить (dictionaries/{en,ru}.ts + types.ts), namespace новый не заводить; радиусы только var(--radius*).
```

### Перечень черновиков (9 групп)

1. D1 contracts fork/revert/tool-call — `SessionForkRequest/Response/Boundary`, `RevertStageRequest`, `RevertInfo`, `SnapshotDiff`, `ToolCallInfo` + zod-схемы + реэкспорт.
2. D2 tools — `ToolRegistryService` / `ToolDispatchService` / `ToolSettlement` + пример `ReadTool` (шаблон для write/edit/glob/grep/shell/patch/todo).
3. D3 loop+runner — `pendingCalls` / `nextRequest` / `collect` чистые функции + `SessionRunnerService.runTurn` + `utils/tool-label/` чистая функция.
4. D4 agents — `AgentRegistry.resolve/list` (default build, hidden/subagent-фильтр) + `SubagentJobService` (job через ToolSettlement).
5. D5 snapshots/revert/fork — `SnapshotsService.capture/diff/restore` + `RevertService.stage/clear/commit` + `Harness.fork` + dto-реэкспорт.
6. D6 frontend client/hooks — `forkSession/stageRevert/clearRevert/commitRevert/snapshotDiff` + `useForkSession/useRevert/useSnapshotDiff` (invalidate через существующие ключи).
7. D6 live-статусы — `LiveStatus { activeAgentId, activeToolName }` деривация в `useChat.frameText`, рендер в `chat-window/agent-thinking/chat-tools-timeline/agent-selector`, строки `t.chat` (en/ru).
8. Тест-карта черновиков — `__tests__/tool-dispatch.spec.ts` (unknown/invalid/outside-jail/order), `runner/__tests__/loop.spec.ts` (fold/usage), `utils/tool-label/__tests__/`, `useChat.test.tsx` (кадры→состояние→сброс), guard `no-opencode-transport.test.ts`.
9. §5.2 DESIGN-привязка — плоский список без Card-в-Card (§7), радиусы var(--radius*) child<parent (§4), токены без хардкода (§2), ноль декора (§4.1/§3), кит + a11y (§5), i18n t.chat en/ru + плоские URL, владелец-человек approve (§6); D6-черновики помечены DESIGN-рамкой.
