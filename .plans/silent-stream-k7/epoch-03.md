# Epoch 3: Decision foundation — границы и конфликты

## Hypothesis
- Фикс обязан быть аддитивным к SSE-контракту (новые типы — проекция, не замена envelope) и соблюдать фронт-канон (слои, useEffect, guard).
- Конфликт: хочется богатый tool-прогресс, но `recordHostEvent` пишет в историю только текст — tool-детали обязаны остаться ephemeral (SSE-only), иначе раздуем durable-схему.

## Evidence Found
- File: `packages/contracts/AGENTS.md` — `contracts/openapi.yaml` источник правды, пакет зеркалит поле-в-поле; расхождение — баг пакета.
- File: `apps/frontend/AGENTS.md:44-50,67-69,79-83` — data-хуки только React Query, исключение streaming/SSE (`useChat` useEffect + коммент); цепочка `send → POST messages → SSE deltas (scope frame.session) → session.step.ended коммит`; `stop()` abort + interrupt + partial-коммит + глушение кадров.
- File: `apps/backend/AGENTS.md` — normal path однострочники через AppLogger без стеков/секретов; `REPOS_ROOT` единственный корень; e2e через testcontainers.
- Pattern: существующий `frameText` уже делает `frame.data as {delta?...}` guards для `session.text.*` без narrowed-схем — прецедент для tool-проекции без ломки контракта.

## Decisions
- Decision: SSE-контракт расширяем только аддитивно — новые `session.tool.*`/`reasoning` типы проектируются фронтом через guarded reads, envelope `sessionStreamFrameSchema` не сужаем; при желании добавляем опциональные narrowed-схемы + тесты, openapi.yaml обновляем зеркально.
- Alternatives considered: сузить envelope enumом типов — отвергнуто (сломает forward-compat раннера, каждый новый тип раннера ронял бы стрим).
- Rationale: fail-soft парсер уже толерантен к неизвестным типам; дроп — в проекции, не в envelope.
- Decision: tool-прогресс — ephemeral SSE-state (activeToolName + toolTrace переходы), durable история — только текст (recordHostEvent не трогаем кроме логов).
- Alternatives considered: писать tool-кадры в messages — отвергнуто (ломает `toChatMessages` text:null-скип, историю, fork/revert границы).
- Rationale: критерии требуют «прогресс + финальный текст в messages; пустой тред только до первого кадра» — текст коммитится, тулзы — статусом.
- Decision: карточки строго diag→fix→verify, каждая с файлами + чек-листом + complexity/риск + done.
- Rationale: требование постановки «Только план».

## Confirmed Plan Items
1. Аддитивность SSE — reason: не ломать раннер/relay; artifact: contracts + sessions-client; validation: guard-тесты зелёные.
2. Ephemeral tool-state vs durable text — reason: не раздувать историю; artifact: useChat + harness untouched persist; validation: ревью.
3. Фронт-канон нерушим — reason: AGENTS.md; artifact: слои/kit/guard; validation: lint+build.

## Open Questions
- Нужны ли narrowed zod-схемы для tool-типов или достаточно guarded reads (решение на fix-карточке после diag-лога реальных payload-форм)?
- Логировать ли сырые `frame.type` на бэке в debug (без data-секретов) или только на фронте в trace?

## Next Epoch Focus
- Refinement: расписать конкретные задачи diag/fix/verify с файлами, функциями, API-контрактами, чек-листами, complexity/риском.
