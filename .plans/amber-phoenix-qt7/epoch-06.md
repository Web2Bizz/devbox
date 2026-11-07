# Epoch 6: Finalize

## Hypothesis
PLAN.md + evolution-log.md синтезируют эпохи 1–5 в исполняемую последовательность без потери решений.

## Evidence Found
- File: `epoch-01.md` — гипотеза и non-negotiable (свой транспорт).
- File: `epoch-02.md` — конкретные строки-доказательства по всем путям ТЗ.
- File: `epoch-03.md` — wire-решения (ping-коммент, stream.error, Last-Event-ID, ?session=, fail-soft, гарды, URL).
- File: `epoch-04.md` — 7 карточек и порядок.
- File: `epoch-05.md` — валидация против канонов (AppLogger, boundary, C4-gate, guard-тесты).

## Decisions
- Decision: зафиксировать PLAN.md ниже как синтез (7 карточек C0–C6, только план, никакого кода).
- Alternatives considered: переоткрыть спор heartbeat-кадр vs коммент — rejected (решён в Epoch 3: коммент).
- Rationale: каждая эпоха grounded в предыдущей; история решений — в evolution-log.md, superseded нет.

## Confirmed Plan Items
1. PLAN.md создан — reason: исполняемая последовательность для Trello + classify_build.
2. evolution-log.md создан — reason: трассируемость решений.

## Open Questions
- Нет. Имплементация начинается с C0; вопросы монотонности id и точного watchdog-таймаута — внутри карточек.

## Next Epoch Focus
- Исполнение: завести Trello-карточки C0–C6, далее build per-card (fast/smart по карточке).
