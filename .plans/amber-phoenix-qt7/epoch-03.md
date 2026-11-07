# Epoch 3: Decision foundation

## Hypothesis
Контрактные решения фиксируем до кодирования, чтобы карточки не разъехались.

## Evidence Found
- Pattern: `sessionStreamFrameSchema = {id, type: string, data: record, session?}` — новый терминальный тип проходит envelope без миграции, но фронт должен различать его до `frameText`.
- Pattern: `filterFrame` применяется ПОСЛЕ `mapFrame` — `?session=` естественно ложится как server-side предикат поверх существующего `localSessionIds ∈` (не замена, а сужение).
- Pattern: `useChat frameText` уже знает терминалы `session.text.ended / session.execution.succeeded / session.step.ended → idle/finalize` — новый `stream.error` должен идти отдельным каналом (error, не finalize).
- Conflict: `if (!sendingRef.current) continue` стоит ДО `frame.session` проверки — после F5 (sending=false, тред жив) подписка глушит догоняющие кадры. Решение: разделить гарды.
- Conflict: `setError` на любую транспортную ошибку vs тихий backoff — решение: транзиент молча redial, ErrorState только на терминальный error-кадр / REST-историю.

## Decisions
- Decision: heartbeat = SSE-коммент `: ping\n\n` каждые ~15s из `relaySse` (транспортный уровень, не кадр), фронт-watchdog: если ни кадра ни ping > N (напр. 30–45s) → тихий redial без `setError`. Alternatives: `data: heartbeat` кадр — rejected (загрязняет `sessionStreamFrameSchema`, будит `frameText`).
- Decision: терминальный кадр = `data: {id, type:'stream.error', data:{message?, code?}, session?}` + `res.end()` сразу после; фронт: fail-soft — показать ErrorState с retry, **тред не затирать** (ошибка отдельно от messages). Alternatives: тихий `res.end()` — rejected (неотличим от idle → вечный sending, это и есть текущий баг).
- Decision: курсор = `Last-Event-ID` request header + `?cursor=` fallback; сервер шлёт `id: <frame.id>` на каждом `data:` (SSE-нативно) + replay начинает после cursor (по `localFrames` id, при неизвестном cursor — полный локальный replay, не пустой). Alternatives: кастомный `?since=` — rejected (ломаем SSE-семантику, прокси/клиенты знают `Last-Event-ID`).
- Decision: `?session=` — опциональный query `GET /events?projectId=&session=`; сервер: C4-gate прежний + сужение `localSessionIds ∩ {session}` + тот же `filterFrame` остаётся как defense-in-depth. Пустой/чужой session → тихий пустой стрим (не 404 — не ликать существование). Alternatives: обязательный session — rejected (ломает существующие подписки без session, мульти-чат экраны).
- Decision: fail-soft парсинг одного кадра: `JSON.parse` в try + `sessionStreamFrameSchema.safeParse` (не `.parse`); битый чанк → счётчик + skip, стрим живёт. Alternatives: FAIL LOUD — rejected (один битый кадр = смерть треда, текущий баг).
- Decision: sending-гард vs подписка: подписка **всегда активна** при `projectId` (копит `streamingRef`/partLens независимо от sending); `sending` влияет только на `finalize()`/индикаторы. `stop()` дропает через `abortedTurnRef`/эпоху, а не через глушение всей подписки. Alternatives: оставить `continue` при !sending — rejected (теряем догон после F5).
- Decision: persist URL: path `sessions/[sessionId]` остаётся источником `sessionId`; `agentId` → `?agent=` search-param (синк двусторонний: `setAgentId` пишет в URL, инициализация читает из URL с фолбэком `DEFAULT_AGENT_ID='ask'`); после `createSession` — `router.replace` на новый sessionId без потери истории. Alternatives: localStorage — rejected (не шарится ссылкой, ТЗ требует URL).
- Decision: resync триггеры: `window online` + `document visibilitychange→visible` → тихий `reload()` (REST-история + redial SSE, nonce++), без `setError`.
- Decision: Vercel useChat / React Query для SSE — **запрещены** (guard `no-opencode-transport.test.ts`, AGENTS.md streaming-исключение с комментом-обоснованием в `useChat`).

## Confirmed Plan Items
1. Контракт heartbeat/error/cursor/session — reason: карточки C0–C3 пишут один wire-формат.
2. Разделение гардов и политика ошибок — reason: карточки C4/C6 без этого вернут баги.

## Open Questions
- Точный heartbeat-интервал (15s vs 25s под конкретный прокси) — оставить константой `HEARTBEAT_MS` с тестом на наличие `: ping`.
- Нужен ли `Retry:` SSE-заголовок от сервера — опционально, фронт-backoff остаётся источником правды.

## Next Epoch Focus
- Refinement: разложить по карточкам файлы/чек-листы/зависимости/complexity/риск/builder.
