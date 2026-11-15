# Epoch 4: Refinement — карточки, зависимости, сложность

## Hypothesis
7 карточек покрывают все 5 пунктов ТЗ + приёмку; порядок исключает гонки wire-формата.

## Evidence Found
- File: `sse-relay.ts:89-94` — заголовки SSE ставятся до `flushHeaders` — heartbeat-таймер стартует после, чистится в `finally` (точка C0).
- File: `session-harness:1056-1073` — replay без cursor; `frames` = `this.localFrames` (in-memory) — cursor ищется по `frame.id` (точка C1).
- File: `sessions.controller.ts:303-311` — `events()` без `@Query('session')` (точка C2).
- File: `sessions-client.ts:219-239` — split `\n\n` + `parse` throw (точка C3).
- File: `useChat.ts:349-357` — sending-гард до session-фильтра (точка C4).
- File: `chat-section.tsx:41` + `sessions/[sessionId]/page.tsx:12-13` — нет URL-синка agent (точка C5).
- File: `chat-window.tsx:107-113` — error заменяет тред (точка C6).

## Decisions
- Decision: порядок C0(root) → C1,C2(branch, после C0) → C3(branch, после C0+C2) → C4(branch, после C3) → C5(leaf, после C4) → C6(leaf, после всех). Alternatives: параллелить C4 раньше C3 — rejected (хук зависит от fail-soft/watchdog-сигналов транспорта).
- Decision: complexity (0-20) и риск (0-8) оценены по файлам/ветвлениям/внешним факторам; builder: score≤8+риск low → `build-fast`, иначе `build-smart`.
- Rationale: heartbeat+error (C0) меняют wire — все потребители после; URL (C5) только читает stabilised `sessionId/activeSessionId`.

## Confirmed Plan Items
1. C0 root — heartbeat + `stream.error` + `id:` на кадрах (sse-relay, контракты, openapi).
2. C1 branch — cursor/Last-Event-ID в replay-буфере harness.
3. C2 branch — `?session=` в controller/service/harness-filter.
4. C3 branch — транспорт fail-soft + Last-Event-ID + watchdog-сигнал (sessions-client, client).
5. C4 branch — useChat self-healing (watchdog, backoff-тишина, resync, гарды, страховка sending).
6. C5 leaf — persist sessionId+agentId в URL.
7. C6 leaf — политика ErrorState + приёмка/e2e.

## Open Questions
- Подтвердить монотонность `frame.id` в `localFrames` при имплементации C1 (если нет — серверный seq-обёртка, additive).
- Точный watchdog-таймаут (30s vs 45s) — финализировать в C4 с учётом HEARTBEAT_MS из C0.

## Next Epoch Focus
- Validation: сверить каждую карточку с существующими паттернами (AppLogger, boundary-schemas, C4-gate, guard-тесты) + дописать критерии done.
