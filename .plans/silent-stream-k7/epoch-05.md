# Epoch 5: Validation — план против канона и границ

## Hypothesis
- План из 3 карточек покрывает симптом полностью и не нарушает канон: слои, guard, SSE-аддитивность, ephemeral-инструменты.

## Evidence Found
- File: `apps/frontend/src/__tests__/no-opencode-transport.test.ts` — guard запрещает `@opencode-ai/sdk` и `/api/opencode/*` в src+app+package.json включая комментарии; наш план его не касается (только доменные `/api/v1/sessions*` + `@rush-code/contracts`).
- File: `apps/frontend/AGENTS.md:79-83` — цепочка чата и stop-семантика сохранены: F2 не меняет finalize/abort/interrupt, только добавляет сигналы.
- File: `packages/contracts/AGENTS.md` — openapi.yaml зеркало: если добавим narrowed tool-схемы, обновим YAML + пакет + тесты синхронно.
- Pattern: `DESIGN.md` прикладной — timeline/badge/shimmer уже kit-only, новых hex/кастом-стилей не вводим.
- Check: `bun run lint` (tsc --noEmit + biome) + `bun run build` (next build --turbopack) — обязательны в V3; бэк-тач только debug-логи через AppLogger однострочниками.

## Decisions
- Decision: бэкенд-изменения ограничить diag-логами (debug, без data-тел) + проверкой `?session=`/resolve-матча; persist (`recordHostEvent`) не менять.
- Alternatives considered: менять persist под тулзы — отвергнуто (superseded, epoch-3).
- Rationale: минимальный blast radius, no migration, no schema change.
- Decision: complexity — D1 low, F2 medium, V3 low; риск — D1 low, F2 medium (SSE-проекция, главный риск — смешать tool-текст в ответ), V3 low. Митигация F2: tool-текст никогда в `append()/streamingRef`, только в activeToolName/trace; reasoning — в detail/debug.
- Decision: done-условия = критерии постановки дословно + регресс-гейты.
- Rationale: проверяемость без споров.

## Confirmed Plan Items
1. Канон-чек пройден — reason: слои/guard/SSE-исключение/kit соблюдены; artifact: этот epoch; validation: список выше.
2. Blast radius ограничен — reason: 4 фронт-файла + 1 бэк-диаг + опционально контракт; artifact: PLAN.md файлы; validation: ревью.
3. Готов синтез PLAN.md + evolution-log.md — reason: следующий шаг; artifact: файлы; validation: наличие всех секций.

## Open Questions
- Нет открытых — всё, что осталось (точные tool-поля), закрывается D1-логом во время исполнения.

## Next Epoch Focus
- Синтез: создать PLAN.md (карточки diag→fix→verify, файлы, чек-листы, complexity/риск, done) + evolution-log.md, доложить каталог.
