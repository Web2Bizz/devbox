# Epoch 1: Coarse hypothesis

## Hypothesis
Единый hover-фон футера сообщения чата должен быть прозрачным везде. В `chat-message.tsx` часть кнопок уже имеет `hover:bg-transparent` (like/dislike частично, copy полностью), а fork/revert (`Button variant="ghost"`) — нет. Достаточно добавить `hover:bg-transparent focus-visible:bg-transparent` всем кнопкам футера без смены variant и без hex.

## Evidence Found
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx` — единственный файл модуля (подтверждено `ls`, рядом только `index.ts`-реэкспорт).
- Pattern: канон `apps/frontend/AGENTS.md` — DESIGN-токены, hex только `:root`/`.dark`; проверки `bun run lint` + `bun run build`.

## Decisions
- Decision: scope = 1 файл, 1 карточка, low/low.
- Alternatives considered: отдельный CSS-класс / смена variant на link — отвергнуты (ТЗ: variant не менять, только классы).
- Rationale: минимальный diff, соответствует «прозрачный всем».

## Confirmed Plan Items
1. Унифицировать hover/focus футера — причина: единый визуал, артефакт: `chat-message.tsx`, валидация: визуально + lint.

## Open Questions
- Точный текущий класс каждой кнопки (нужна построчная сверка).
- Есть ли тесты на футер, которые тронет изменение классов?

## Next Epoch Focus
- Построчная сверка классов кнопок + поиск тестов/зависимостей.
