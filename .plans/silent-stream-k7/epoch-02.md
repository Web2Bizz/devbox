# Epoch 2: Evidence gathering — где теряются кадры

## Hypothesis
- Потеря в трёх местах: (а) контракт-envelope пропускает, но фронт-парсер дропает; (б) SSE-цикл фильтрует по `frame.session`; (в) рендер не показывает tool-прогресс кроме псевдо-trace.

## Evidence Found
- File: `apps/frontend/src/hooks/useChat.ts:124-181 frameText` — обрабатывает только `session.text.delta` (data.delta string), `session.text.ended` (data.text → full/idle), `session.execution.succeeded`/`session.step.ended` (idle), legacy `message.part.delta/updated` + `session.idle`; всё остальное → `null → continue` (:481). Tool/reasoning типов нет.
- File: `apps/frontend/src/hooks/useChat.ts:193-204 frameToolName` — только `type === 'message.part.updated'` + чтение `tool/toolName/name` из `part`, `type==='text'` → null. Новые `session.tool.*` никогда не мапятся → `activeToolName` всегда null для host-тулзов, `setActiveToolName` (:472-473) не срабатывает.
- File: `apps/frontend/src/hooks/useChat.ts:439-568 SSE-цикл` — `if (!sid || frame.session !== sid) continue` (:461); `if (abortedTurnRef.current) continue` (:459); `lastEventIdRef` только own-session (:471); `frameText → null → continue` без trace; trace пишется только для `session.text.delta/ended`, `execution.succeeded/step.ended`, connect/prompt/auth/history/interrupt/reload — tool-переходов нет. `thinking = sending && !streamingText` (chat-window).
- File: `apps/frontend/src/api/sessions-client.ts:202-292 sessionEventStream` — fail-soft: `JSON.parse` try + `sessionStreamFrameSchema.safeParse`, битый чанк → skip-counter, heartbeat `:ping` → `onActivity` без yield. `sessionId → ?session=`, `lastEventId → Last-Event-ID/?cursor=`.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts:975-991 toStreamFrame` — passthrough `{id,type,data}` + hoist `data.sessionID → session` через project-scoped `resolve()`; неизвестные типы не фильтруются здесь — дроп позже.
- File: `apps/backend/src/processes/modules/ai/modules/sessions/session-harness.service.ts:1003-1195 streamEvents` — `?session=` сужает до одной сессии, unknown/foreign → quiet empty stream (heartbeat only); `filterFrame` (:1180-1193) пропускает только `session ∈ localSessionIds`; replay + live merge через `localFrames` + `host.subscribeEvents`; `recordHostEvent :846-910` аккумулирует ТОЛЬКО `session.text.delta/ended`, `session.step.ended`, `execution.succeeded/failed/interrupted` для durable persist — tool-кадры в историю не пишутся (по дизайну, текст — да).
- File: `packages/contracts/src/sessions/sessions.schema.ts:148-153 sessionStreamFrameSchema` — envelope `{id, type: string, data: record, session?}` permissive; narrowed только `message.part.delta/updated` (:161-187) + `stream.error` (:193-201). `session.tool.*`/`reasoning.*` схем нет — фронт вынужден читать через `frame.data as` + guards (как уже делает frameText для text.delta).
- File: `apps/frontend/src/components/chat/chat-window/chat-window.tsx:87 thinking, :141-164 thinking-row, :165-197 streaming-row, :217-219 timeline-gate` — пустой тред + thinking=false + streamingText='' → EmptyState; thinking-row показывает `AgentThinking + activeAgent/activeTool badges`; streaming — ghost bubble + `chat-streaming-status`; timeline только под скроллером, вне `MessageScrollerItem` (не крадёт scrollAnchor).
- File: `apps/frontend/src/components/chat/chat-window/chat-tools-timeline.tsx:31-35` — `if (events.length===0 && !liveToolName) return null` — при tool-дропе и псевдо-trace из 2-3 событий выглядит как «пусто».
- File: `apps/frontend/src/components/chat/chat-window/agent-thinking.tsx:41-47` — live `agent · tool` если есть, иначе ротация `t.chat.thinking` каждые 1.6s. При null tool — только ротация, что и видно как «висит без прогресса».
- Pattern: фронт-канон `apps/frontend/AGENTS.md` — `useChat` useEffect-исключение с комментом-обоснованием (не React Query), `client.ts` единственный fetch-слой, `sessions-client.ts` доменный фасад, guard `no-opencode-transport.test.ts`, kit-only chrome, hex только в :root/.dark.

## Decisions
- Decision: дроп доказан на двух уровнях — frameText/null и frameToolName/legacy-only; бэкенд toStreamFrame/filterFrame — подозреваемые №2 (нужен diag-лог).
- Alternatives considered: винить только бэкенд-фильтр — отвергнуто, фронт-дроп достаточен для симптома даже при целых кадрах.
- Rationale: evidence из кода покрывает оба слоя, diag должен различить их рантаймом.

## Confirmed Plan Items
1. frameText дропает host-tool/reasoning кадры — reason: только text/execution/step маппятся; artifact: useChat.ts:124-181; validation: код-ридинг epoch-2.
2. frameToolName слеп к `session.tool.*` — reason: ждёт только message.part.updated; artifact: useChat.ts:193-204; validation: код-ридинг.
3. Timeline показывает только псевдо-события — reason: нет tool-переходов в pushTrace; artifact: useChat.ts:491-506 + timeline.tsx; validation: код-ридинг.
4. Контракт-envelope permissive, narrowed-схем для tool-типов нет — reason: sessions.schema.ts:148-201; artifact: контракт; validation: код-ридинг.

## Open Questions
- Точный enum host-типов в auto-цепочке (нужен рантайм-лог сырых `frame.type` до фильтра)?
- Падает ли `sendSessionMessage` POST раньше стрима (длинный Auto-chain, SEND_TIMEOUT_MS)?
- Терминатор какой (text.ended vs step.ended vs execution.succeeded) реально завершает auto-turn?

## Next Epoch Focus
- Decision foundation: превратить evidence в diag/fix/verify границы, зафиксировать SSE-аддитивность и фронт-канон как non-negotiable, выявить конфликты.
