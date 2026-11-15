# Epoch 2: Evidence gathering

## Hypothesis
Расхождение подтверждено построчно: `FEEDBACK_TOGGLE_CLASS` без `focus-visible`, `CopyButton` уже эталон, fork/revert без прозрачности вообще.

## Evidence Found
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:52` — `const FEEDBACK_TOGGLE_CLASS = 'bg-transparent text-muted-foreground hover:bg-transparent'` — нет `focus-visible:bg-transparent`, используется в 2 местах (`:140`, `:170` like/dislike `ToggleGroupItem`).
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:198-206` — `CopyButton variant="ghost" size="icon" className="text-muted-foreground hover:bg-transparent focus-visible:bg-transparent"` — эталон, уже соответствует ТЗ, только проверить.
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:208-221` — fork `Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground"` — нет hover/focus прозрачности, `data-testid="chat-message-fork"`, `aria-label={t.chat.forkBefore}`.
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:222-235` — revert `Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground"` — аналогично, `data-testid="chat-message-revert"`, `aria-label={t.chat.revert}`.
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:44-51` — комментарий объясняет override kit `toggleVariants hover:bg-accent` через `cn`+tailwind-merge (className last wins).
- Pattern: `apps/frontend/src/components/chat/__tests__/chat-window.test.tsx:133-134,194` — тесты проверяют только `data-testid chat-message-user/assistant` и `pre` внутри assistant; классов кнопок не ассертят — смена классов безопасна.
- Pattern: ветка `feat/cli-cloud-chat` подтверждена (`git branch --show-current`); корень `/media/codebase/@web2bizz/devbox`.

## Decisions
- Decision: эталон строки — `text-muted-foreground hover:bg-transparent focus-visible:bg-transparent` (как у CopyButton).
- Alternatives considered: вынести общую константу для Button — отвергнуто на low-depth (держать минимальный diff, только дописать классы инлайн).
- Rationale: like/dislike уже имеют общий `FEEDBACK_TOGGLE_CLASS` — правится в 1 месте; fork/revert — 2 инлайн-правки.

## Confirmed Plan Items
1. Дописать `focus-visible:bg-transparent` в `FEEDBACK_TOGGLE_CLASS` — причина: keyboard-focus = hover, артефакт: строка 52, валидация: `rg FEEDBACK_TOGGLE_CLASS`.
2. Дописать `hover:bg-transparent focus-visible:bg-transparent` в fork/revert Button — причина: ghost variant даёт `hover:bg-accent`, артефакт: строки 213, 227, валидация: `rg hover:bg-transparent chat-message.tsx` = 4 попадания.
3. Проверить CopyButton без изменений — причина: уже эталон, артефакт: строка 202, валидация: визуальная сверка.

## Open Questions
- Нужна ли правка комментария над `FEEDBACK_TOGGLE_CLASS` (упомянуть focus-visible)? — на решение Epoch 3.

## Next Epoch Focus
- Финальные решения: комментарий, variant-табу, критерии приёмки и lint.
