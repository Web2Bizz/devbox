# Epoch 1: Coarse hypothesis

## Hypothesis
Самописный транспорт (`useChat.ts` + `sessions-client.ts` поверх `client.ts streamSessionEvents`) можно дотянуть до самовосстановления без Vercel `useChat`, добавив 5 пунктов ТЗ: heartbeat, курсор replay, `?session=` фильтр, persist в URL, терминальный error-кадр + fail-soft + resync + разделение sending-гарда. Бэк: `sse-relay.ts` (транспорт), `session-harness.service.ts:1056-1073` (replay-буфер), `sessions.controller.ts`/`sessions.service.ts` (`GET /events`), контракты `sessions.schema.ts` + `openapi.yaml`.

## Evidence Found
- Факт ТЗ: ветка `feat/cli-cloud-chat`, base `c0dee12`, стрим прерывается и не восстанавливается, фронт ломается при живом бэке.
- Non-negotiable: Vercel useChat отклонён — остаёмся на своём транспорте.

## Decisions
- Decision: планировать как Trello-карточки с порядком root/branch/leaf + complexity/риск под `classify_build`.
- Alternatives considered: Vercel useChat / React Query SSE — rejected (решение пользователя, guard-тест запрещает чужой транспорт).
- Rationale: 5 пунктов ТЗ уже привязаны к точным путям — декомпозиция по слоям транспорт→буфер→фильтр→клиент→хук→URL→политика ошибок.

## Confirmed Plan Items
1. Карточки C0–C6 с файлами, чек-листами, зависимостями — причина: Trello + builder требуют атомарности.
2. Никакого кода, только план — причина: явное требование задачи.

## Open Questions
- Текущий replay-буфер: размер, id-монотонность, ttl? (→ Epoch 2)
- Есть ли heartbeat сейчас? Как `sessionEventStream` реагирует на битый кадр? (→ Epoch 2)
- Где живёт страница чата для persist URL? (→ Epoch 2)

## Next Epoch Focus
- Evidence gathering: прочитать `sse-relay`, `session-harness:1056+`, `sessions-client sessionEventStream`, `useChat SSE-loop`, `chat-section`, `chat-window`, `client.streamSessionEvents`, контракты.
