# PLAN — Самовосстановление самописного useChat (все 5 пунктов)

> Ветка: `feat/cli-cloud-chat`, base `c0dee12`. Только план, никакого кода.
> Non-negotiable: остаёмся на своём транспорте (`useChat.ts` + `sessions-client.ts`); Vercel `useChat` отклонён (guard `no-opencode-transport.test.ts`).
> Канон: фронт — `apps/frontend/AGENTS.md` (streaming-исключение `useEffect` с комментом-обоснованием, query-ключи из `query-keys.ts` не для SSE); бэк — `apps/backend/AGENTS.md` (только `AppLogger`, fail-fast без тихих фолбэков, C4-gate 404 без утечки); контракты — `packages/contracts/AGENTS.md` (зеркало `contracts/openapi.yaml` поле-в-поле).

## Порядок и зависимости (root / branch / leaf)

```
C0 [root]   heartbeat + stream.error + id:
 └─ C1 [branch] cursor/Last-Event-ID (blocked by C0)
 └─ C2 [branch] ?session= фильтр (blocked by C0)
      └─ C3 [branch] транспорт fail-soft + watchdog-сигнал (blocked by C0, C2)
           └─ C4 [branch] useChat self-healing (blocked by C3; e2e-догон — C1)
                └─ C5 [leaf] persist URL (blocked by C4)
                     └─ C6 [leaf] ErrorState-политика + приёмка (blocked by C0–C5)
```

C1 и C2 независимы между собой, могут идти параллельно после C0.

---

## C0 [root] — SSE heartbeat + терминальный error-кадр + `id:` на кадрах

**Trello:** title `C0 SSE heartbeat + stream.error (relay)` · Blocked by: — · Blocks: C1, C2, C3
**Покрывает ТЗ:** п.1 (heartbeat) + п.5-часть (терминальный error-кадр вместо тихого обрыва).
**Файлы:**
- `apps/backend/src/common/sse/sse-relay.ts` (таймер heartbeat, `id:` префикс, error-кадр + `res.end()`)
- `apps/backend/src/common/sse/__tests__/*` (юнит: ping присутствует, error-кадр формат)
- `packages/contracts/src/sessions/sessions.ts` + `sessions.schema.ts` (тип `stream.error`, narrow-схема optional)
- `contracts/openapi.yaml` (документация SSE: ping-коммент, `id:`, `stream.error`)

**Чек-лист:**
- [ ] `relaySse` после `flushHeaders` стартует heartbeat-таймер (`HEARTBEAT_MS`, напр. 15s): пишет `: ping\n\n` при простое; таймер чистится в `finally`, не мешает `onClose`/abort.
- [ ] Каждый `data:` кадр пишется как `id: <frame.id>\nevent: message\ndata: {...}\n\n` (id — для `Last-Event-ID`; имя event — если уже есть конвенция, не ломать).
- [ ] Mid-stream failure (не-abort): вместо тихого `break` пишется терминальный `data: {id, type:'stream.error', data:{code?, message?}, session?}` затем `res.end()`; AbortError/disconnect — по-прежнему тихо (debug, без кадра).
- [ ] Логи только `AppLogger`, только count/строки (`heartbeat on`, `stream.error …`), без тел кадров/секретов; `droppedByFilter` поведение не меняется.
- [ ] Контракт: `stream.error` проходит envelope `{id,type,data,session?}`; openapi.yaml описывает ping + error-кадр; `tsc` зеркала ок.
- [ ] Юнит: heartbeat-коммент в потоке; error-кадр при инжектированной mid-stream ошибке; abort без error-кадра.

**Complexity:** score `9/20` (транспорт + wire-контракт + тесты).
**Риск:** score `3/8`, факторы `[external]` (прокси-долгоживущие сокеты, тайминги; breaking нет — additive).
**Builder:** `build-smart` (wire-формат, задевает всех потребителей).
**Done:** прокси-idle держится ping; обрыв раннера = `stream.error` + конец стрима (не тишина); `bun run lint` + `build` зелёные.

---

## C1 [branch] — Курсор / Last-Event-ID в replay-буфере harness

**Trello:** title `C1 replay cursor Last-Event-ID (harness)` · Blocked by: C0 · Blocks: C4(e2e-догон)
**Покрывает ТЗ:** п.2 (курсор/Last-Event-ID в `session-harness.service.ts:1056-1073`).
**Файлы:**
- `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts` (`streamEvents` subscribe/replay, cursor-поиск)
- `apps/backend/src/processes/modules/ai/modules/sessions/sessions.service.ts` (проброс cursor, если нужен)
- `apps/backend/src/processes/modules/ai/modules/sessions/__tests__/*` (replay с/без cursor)

**Чек-лист:**
- [ ] `streamEvents` читает cursor из `Last-Event-ID` header (первично) + `?cursor=` fallback; ищет его в `localFrames` по `frame.id`.
- [ ] Replay отдаёт только кадры **после** cursor, отфильтрованные по `localSessionIds` (существующий предикат); неизвестный/пустой cursor → полный локальный replay (не пустой, не весь глобальный).
- [ ] Подтвердить монотонность `frame.id` в `localFrames`; если runner-id немонотонны — additive серверный `seq` (не ломая envelope), cursor по нему.
- [ ] `LOCAL_IDLE_MS`/`STREAM_CAP_MS`/`POLL_MS` семантика не меняется; cursor не продлевает мёртвый стрим.
- [ ] Логи: только count (`replay from cursor n/m`), без id-контента лишнего; `AppLogger` only.
- [ ] Юнит: redial с cursor не дублирует; без cursor — полный локальный replay; чужой cursor — фолбэк без утечки чужих сессий.

**Complexity:** score `11/20` (буфер + идемпотентность replay + seq-вопрос).
**Риск:** score `5/8`, факторы `[data, external]` (дубли/потери середины треда при неверном cursor; silent-data-loss риск).
**Builder:** `build-smart`.
**Done:** повторный коннект догоняет только недостающее; дублей дельт нет; чужие сессии не утекают.

---

## C2 [branch] — `?session=` фильтр в `GET /events`

**Trello:** title `C2 ?session= filter GET /events` · Blocked by: C0 · Blocks: C3
**Покрывает ТЗ:** п.3 (`sessions.controller.ts`, `filterFrame`).
**Файлы:**
- `apps/backend/src/processes/modules/ai/modules/sessions/sessions.controller.ts` (`@Query('session')`)
- `apps/backend/src/processes/modules/ai/modules/sessions/sessions.service.ts` + `session-harness.service.ts` (сужение `localSessionIds ∩ {session}`, `filterFrame` остаётся defense-in-depth)
- `contracts/openapi.yaml` (`GET /api/v1/sessions/events`: `session` optional query)
- `packages/contracts/...` (если появится query-DTO — зеркало; иначе только yaml)

**Чек-лист:**
- [ ] `events()` принимает опциональный `session`; C4-gate (`projectId` + `assertProjectAccessById`) прежний и первый.
- [ ] Сервер сужает подписку до запрошенной сессии; существующий `filterFrame` (`frame.session ∈ local`) остаётся вторым рубежом.
- [ ] Чужой/пустой `session` → тихий пустой стрим (heartbeat идёт, кадров нет), **не 404/400** (не ликать существование — C4-конвенция).
- [ ] Без `session` — старое поведение (мультиплекс своих сессий), без breaking.
- [ ] openapi.yaml обновлён; swagger-описания 400/404/503 не меняются.
- [ ] Юнит/e2e: `?session=A` не получает кадров B; без параметра — как раньше.

**Complexity:** score `7/20` (тонкий контроллер + фильтр).
**Риск:** score `3/8`, факторы `[security]` (изоляция сессий; breaking нет — optional).
**Builder:** `build-fast` (изолировано, additive).
**Done:** чужие сессии не будят чужой стрим; старые клиенты без `?session=` работают.

---

## C3 [branch] — Транспорт fail-soft + Last-Event-ID + watchdog-сигнал

**Trello:** title `C3 transport fail-soft + Last-Event-ID (sessions-client)` · Blocked by: C0, C2 · Blocks: C4
**Покрывает ТЗ:** п.5-часть (fail-soft парсинг одного кадра) + подготовка п.1 (watchdog) и п.2–3 (cursor/session на wire).
**Файлы:**
- `apps/frontend/src/api/sessions-client.ts` (`sessionEventStream`: try/safeParse, heartbeat-skip, lastEventId)
- `apps/frontend/src/api/client.ts` (`streamSessionEvents`: `?session=`, `Last-Event-ID` header)
- `apps/frontend/src/api/__tests__/*` (битый кадр, heartbeat, query/header)

**Чек-лист:**
- [ ] `sessionEventStream(projectId, signal, opts?: {sessionId?, lastEventId?})`: URL `?projectId=&session=` (когда есть), header `Last-Event-ID` (когда есть); guard-тест транспорта не нарушен.
- [ ] Парсинг чанка: `data:`-линии join (существующее) → `JSON.parse` в try + `sessionStreamFrameSchema.safeParse` (не `.parse`); битый чанк → счётчик + skip, генератор **живёт**; пустой/heartbeat (`: ping`, без `data:`) → skip + сигнал активности для watchdog.
- [ ] Генератор отдаёт `{frame, lastEventId}` или держит внутренний `lastId` + колбэк активности `onActivity?: () => void` (контракт для C4-watchdog; без `setError` внутри).
- [ ] Транспортные ошибки (fetch-throw, `!body`, abort-разрыв) по-прежнему throw наружу (C4 решит тихо redial vs терминал); парсинг-ошибки — **никогда** throw.
- [ ] Без логов тел кадров; `withAuth`/401-ротация не меняется; `parseBoundary` для REST не трогается.
- [ ] Юнит: поток `[good, broken-json, good, broken-schema, good, : ping]` → 3 good-кадра, стрим не умер; query/header уходят корректно.

**Complexity:** score `10/20` (парсер + wire + тесты).
**Риск:** score `4/8`, факторы `[external]` (маскировка реальных разрывов при перегибе skip — лечится счётчиком + C4-watchdog).
**Builder:** `build-smart` (критический путь стрима).
**Done:** битый кадр скипается без ErrorState на весь тред; heartbeat не парсится как кадр; cursor/session уходят на сервер.

---

## C4 [branch] — `useChat` self-healing: watchdog, тихий backoff, resync, разделение гардов

**Trello:** title `C4 useChat self-healing (watchdog/resync/guards)` · Blocked by: C3 (C1 для e2e-догона) · Blocks: C5
**Покрывает ТЗ:** п.5-часть (resync on online/visibilitychange + разделение sending-гард vs подписка + терминальный error) + п.1-часть (watchdog).
**Файлы:**
- `apps/frontend/src/hooks/useChat.ts` (SSE-loop, watchdog, backoff, resync, finalize, sending-страховка)
- `apps/frontend/src/hooks/__tests__/*` (моки `sessionEventStream`: обрыв, error-кадр, битый кадр, F5-догон)

**Чек-лист:**
- [ ] Подписка **всегда активна** при `projectId` (+`sessionIdRef` когда есть): убрать `if (!sendingRef.current) continue` до session-фильтра; вместо этого: копление `streamingRef`/partLens всегда, `finalize()` (коммит assistant-строки) только когда `sendingRef` И терминатор своей сессии (`session.text.ended/execution.succeeded/step.ended`); `stop()` вводит эпоху/abort-turn чтобы поздние кадры прерванного turn не коммитились.
- [ ] Терминальный `stream.error` (C0): `setError` + `sending=false` + тред **сохраняется** (ошибка — отдельно, см. C6); транзиент (throw транспорта, watchdog-сработка) → тихий backoff-redial 1s→15s **без** `setError`.
- [ ] Watchdog: `onActivity` (кадр или `: ping` из C3) сбрасывает таймер (напр. `HEARTBEAT_MS*2 + запас`); просрочка → abort + тихий redial + `Last-Event-ID` = последний `frame.id`.
- [ ] Resync: `window.addEventListener('online')` + `visibilitychange→visible` → тихий `reload()`-лайт (REST `listSessionMessages` + nonce-redial), без `setError`; слушатели чистятся на unmount.
- [ ] Страховка вечного `sending`: если терминатор потерян — сверка по REST (история выросла → `finalize`-коммит и `sending=false`) и/или сверка `GET status`; `send()` поверх висящего sending по-прежнему guarded, но висеть вечно нельзя.
- [ ] `frameText`/`frameToolName` не меняются кроме пропуска `stream.error` мимо текстового тракта; streaming-исключение `useEffect` + коммент-обоснование сохраняется (AGENTS.md).
- [ ] Юнит: обрыв mid-turn → backoff без потери `streamingRef`; `stream.error` → error без затирания messages; F5 (sending=false) догоняет кадры своей сессии; чужая сессия игнорируется.

**Complexity:** score `13/20` (состояние гонок: sending/эпохи/abort/resync).
**Риск:** score `5/8`, факторы `[data, external]` (потеря/дубль коммита, вечный sending, zombie-подписки).
**Builder:** `build-smart`.
**Done:** обрыв = тихое переподключение без потери треда и без вечного sending; F5-догон работает; `stop()` не воскрешается поздними кадрами.

---

## C5 [leaf] — Persist `sessionId` (+`agentId`) в URL страницы чата

**Trello:** title `C5 persist sessionId+agentId in URL` · Blocked by: C4 · Blocks: C6
**Покрывает ТЗ:** п.4 (`features/chat/`).
**Файлы:**
- `apps/frontend/src/features/chat/chat-section.tsx` (синк `activeSessionId`/`agentId` ↔ URL)
- `apps/frontend/app/organizations/[orgId]/projects/[projectId]/sessions/[sessionId]/page.tsx` (чтение `?agent=`, проброс)
- (если есть список/creation-экран сессий — тот же роут, `router.replace` после create; без localStorage как источника правды)

**Чек-лист:**
- [ ] Источник `sessionId` — path `sessions/[sessionId]`; после lazy-`createSession` — `router.replace(.../sessions/[newId]?agent=…)` без потери набранной истории (история уже в `useChat`, replace без reload страницы).
- [ ] `agentId`: инициализация `?agent=` → state (фолбэк `DEFAULT_AGENT_ID='ask'`), `setAgentId` пишет `?agent=` (replace, без скролла); F5 сохраняет и sessionId, и agentId.
- [ ] `ChatSection` остаётся тонкой сборкой (бизнес — в `useChat`); Next `useSearchParams/useRouter` только здесь, не в `useChat` (хук тестируем без роутера).
- [ ] Guard-транспорт не нарушен; `query-keys.ts` не трогается (SSE не на React Query).
- [ ] Тест: F5 на `sessions/abc?agent=ask` → тот же тред + тот же агент; создание с нуля → URL обновился.

**Complexity:** score `8/20` (роутер-синк без гонок).
**Риск:** score `2/8`, факторы `[]` (UI-only; риск — replace-лупы, лечится guard на равенство).
**Builder:** `build-fast`.
**Done:** после F5 чат продолжается с тем же sessionId + догоняет историю (REST) + переподписывается (C4).

---

## C6 [leaf] — Политика ErrorState + приёмка (транзиент ≠ терминал)

**Trello:** title `C6 ErrorState policy + acceptance` · Blocked by: C0–C5 · Blocks: —
**Покрывает ТЗ:** критерии приёмки целиком.
**Файлы:**
- `apps/frontend/src/components/chat/chat-window/chat-window.tsx` (условный ErrorState)
- `apps/frontend/src/features/chat/chat-section.tsx` (проброс `retry=reload`, сохранение треда)
- `contracts/openapi.yaml` + `packages/contracts` (финальный sync wire-документации)
- `apps/frontend/src/__tests__/*`, `apps/backend/.../__tests__/*` (границы), ручной чек-лист приёмки

**Чек-лист:**
- [ ] `ChatWindow`: `error` при **транзиенте отсутствует** (C4 не ставит) — ветка `if (error)` срабатывает только на терминал (`stream.error`, REST-история упала); тред (`messages` + `streamingText`) при ошибке **не затирается** — ErrorState рисуется рядом/поверх с retry, а не `return` вместо треда (уточнить дизайн: баннер над тредом vs замена; решение — баннер, тред видим).
- [ ] `onRetry=reload`: REST-история + redial SSE + сброс watchdog/backoff; повторный F5-цикл не дублирует коммиты.
- [ ] Документация wire (yaml + contracts-комменты): ping, `id:`/`Last-Event-ID`, `?session=`, `stream.error`, fail-soft — в одном месте.
- [ ] Приёмка (ручная, чек-лист в карточке): (1) F5 mid-turn → тот же sessionId + история + resubscribe; (2) kill-proxy/idle 60s → ping держит, watchdog молчит; (3) обрыв SSE → тихий backoff, тред цел, sending не вечный; (4) инжект битого кадра → skip без ErrorState; (5) две сессии → кадры B не будят стрим A (`?session=A` + client-фильтр).
- [ ] `bun run lint` (tsc+biome) + `build` + точечные спеки зелёные; `no-opencode-transport` guard зелёный.

**Complexity:** score `7/20` (UI-политика + доки + приёмка).
**Риск:** score `2/8`, факторы `[]` (не меняет транспорт; риск — дизайн-спор баннер vs замена, решается ревью).
**Builder:** `build-fast`.
**Done:** все 5 критериев приёмки из ТЗ воспроизводятся; план закрыт.

---

## Матрица traceability (пункт ТЗ → карточки)

| Пункт ТЗ | Карточки |
|---|---|
| 1) heartbeat `: ping` + watchdog | C0 (server ping) → C3 (skip+activity) → C4 (watchdog) → C6 (idle-приёмка) |
| 2) курсор/Last-Event-ID replay `1056-1073` | C0 (`id:`) → C1 (cursor) → C3 (отправка) → C4 (догон) |
| 3) `?session=` в `GET /events` + `filterFrame` | C0 (база) → C2 (server) → C3 (client query) → C4 (client-фильтр) → C6 (изоляция) |
| 4) persist sessionId+agentId в URL | C4 (resubscribe) → C5 (URL) → C6 (F5-приёмка) |
| 5) error-кадр + fail-soft + resync + гарды | C0 (error-кадр) → C3 (fail-soft) → C4 (resync+гарды) → C6 (политика) |

## Глобальные Done (закрытие плана)
- [ ] F5 → тот же sessionId + REST-догон + resubscribe; heartbeat держит прокси; обрыв → тихий backoff без потери треда и без вечного sending; битый кадр → skip; чужие сессии изолированы.
- [ ] `bun run lint` + `build` зелёные на затронутых пакетах; контракты ↔ yaml без drift; guard `no-opencode-transport` зелёный.
