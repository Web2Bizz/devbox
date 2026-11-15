# Epoch 5: Validation against patterns

## Hypothesis
Карточки не нарушают каноны репо (логи, граница, скоупы, guard-тесты).

## Evidence Found
- Pattern backend: только `AppLogger`, `console.*` запрещён; `filterFrame` логирует только count (`droppedByFilter`), не контент — C0–C2 обязаны так же (heartbeat/error без тел).
- Pattern: C4-gate `assertProjectAccessById` → 404 без утечки на каждый route — C2 `?session=` не вводит новых 404 (чужой session = пустой стрим, не ошибка).
- Pattern: контракты зеркалят `contracts/openapi.yaml` поле-в-поле — C0/C2 обязаны править оба (schema + yaml), иначе `shape_mismatch`/drift.
- Pattern: фронт `parseBoundary` + `ApiClientError`, токен никогда не логируется — C3/C4 без логов тел кадров.
- Pattern: `src/__tests__/no-opencode-transport.test.ts` — C3–C5 не смеют тянуть `@opencode-ai/sdk` или `/api/opencode/*` даже в комментариях.
- Pattern: тесты рядом `__tests__/*.spec.ts`, e2e через testcontainers — C6 кладёт юнит (heartbeat/error/fail-soft/filter) + ручную приёмку F5/обрыв.

## Decisions
- Decision: каждая карточка несёт `Файлы`, `Чек-лист`, `Зависимости`, `Complexity/Risk/Builder`, `Done` — готово к Trello и `classify_build`.
- Alternatives considered: ужать до 5 карточек (по пунктам ТЗ 1:1) — rejected (п.5 ТЗ = 4 подзадачи: error-кадр + fail-soft + resync + гарды; сливание прячет риски).
- Rationale: 7 карточек = 7 Trello-карт с Blocked-by цепочкой; builder выбирается per-card.

## Confirmed Plan Items
1. Валидировано: heartbeat — коммент, не кадр; error-кадр — envelope-совместим; cursor — SSE-нативен; session-фильтр — сужение, не замена.
2. Валидировано: ErrorState только на терминал; транзиент — тихий backoff.

## Open Questions
- Нет открытых — финализировать PLAN.md + evolution-log.md.

## Next Epoch Focus
- Finalize: собрать PLAN.md (карточки полностью) + evolution-log.md, доложить каталог.
