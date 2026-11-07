# Epoch 3: Decision foundation (final, low-depth)

## Hypothesis
Все 4 кнопки футера приводятся к одному правилу `hover:bg-transparent focus-visible:bg-transparent` тремя точечными правками в одном файле; рисков и конфликтов нет.

## Evidence Found
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx` — весь футер в `MessageFooter` строки 120-236; `variant` везде уже `ghost`/`ToggleGroupItem sm` — менять не нужно.
- Pattern: DESIGN (`apps/frontend/AGENTS.md`) — kit-токены, без hex: план использует только `hover:/focus-visible:` + `text-muted-foreground`, hex нет — compliant.
- Pattern: a11y/testid — `aria-label`/`title`/`data-testid` (copy/fork/revert + like/dislike `aria-label={t.chat.like/dislike}`) сохраняются, классы на них не влияют; тесты `chat-window.test.tsx` классов не проверяют.

## Decisions
- Decision: обновить комментарий над `FEEDBACK_TOGGLE_CLASS` — добавить фразу про `focus-visible:bg-transparent` (1 строка, чтобы док соответствовал коду).
- Alternatives considered: не трогать комментарий — отвергнуто (введёт в заблуждение следующего читателя).
- Rationale: low-cost, сохраняет самодокументированность хака против kit `toggleVariants`.
- Decision: variant/tabу — `variant="ghost"`, `size`, `type`, структуру `MessageFooter` не менять; только `className`.
- Alternatives considered: смена variant — отвергнуто ТЗ.
- Rationale: минимальный diff = минимальный риск регрессии стилей.
- Decision: конфликтов нет — план финализируется без остановки.
- Rationale: 1 файл, 1 карточка, тесты классов не ассертят, hex/variant не затрагиваются.

## Confirmed Plan Items
1. `FEEDBACK_TOGGLE_CLASS` → `'bg-transparent text-muted-foreground hover:bg-transparent focus-visible:bg-transparent'` + правка комментария — причина: like/dislike hover+focus прозрачные, артефакт: строки 44-52, валидация: `rg focus-visible:bg-transparent`.
2. Fork `Button className` → `"h-7 px-2 text-xs text-muted-foreground hover:bg-transparent focus-visible:bg-transparent"` — причина: убрать `hover:bg-accent` от ghost, артефакт: строка 213, валидация: визуал + lint.
3. Revert `Button className` → аналогично fork — причина: симметрия футера, артефакт: строка 227, валидация: визуал + lint.
4. Проверка: `bun run lint` чист + ручной hover/focus всех 4 кнопок одинаковый, a11y/testid на месте — причина: критерии приёмки ТЗ, артефакт: отчёт, валидация: lint exit 0.

## Open Questions
- Нет открытых вопросов (low-depth закрыт).

## Next Epoch Focus
- Синтез в `PLAN.md` (эпох больше не требуется).
