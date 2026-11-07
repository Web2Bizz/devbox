# Epoch 1: Coarse hypothesis

## Hypothesis
- Задача: кнопка копирования под сообщением assistant. Берём готовый `CopyButton` из `@web2bizz/ui`, свой компонент не изобретаем.
- Точка вставки: `MessageFooter` assistant-ветки в `apps/frontend/src/components/chat/chat-message/chat-message.tsx` (рендер через `ChatMessageRow` в `apps/frontend/src/components/chat/chat-window/chat-window.tsx`).
- Копируется `message.text` целиком (включая code-fences как plain text — так же, как видит модель).
- Состояния copy→copied, иконки, a11y — из кита. Стили — только токены (`text-muted-foreground`), без hex.

## Evidence Found
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx` — `ChatMessageRow`, assistant-ветка: `Bubble variant=ghost` + `MessageFooter` с like/dislike `ToggleGroup` + fork/revert `Button variant=ghost size=sm`.
- Pattern: файл уже импортирует из `@web2bizz/ui/widgets` (`Message, MessageContent, MessageText, Bubble, BubbleContent`) и из `@web2bizz/ui/components` (`Button, ToggleGroup`) — новый импорт идёт по тому же каналу.
- Pattern: `apps/frontend/package.json` → `@web2bizz/ui 0.26.3`; установленный `node_modules/@web2bizz/ui` — 0.26.3 (CopyButton доступен).

## Decisions
- Decision: использовать `CopyButton` из `@web2bizz/ui/widgets`, не `useCopy`/свой `navigator.clipboard`.
- Alternatives considered: свой hook + свой Button (отклонено — запрещено условием, дублирует kit-логику fallback через textarea/execCommand).
- Rationale: в ките уже есть controlled/uncontrolled `copied`, `delay`, `writeToClipboard` с fallback, анимация иконок, `sr-only`.

## Confirmed Plan Items
1. Импорт `CopyButton` в `chat-message.tsx` — причина: единый канал `@web2bizz/ui/widgets`.

## Open Questions
- Точный экспорт/пропсы `CopyButton` в 0.26.3, вариант/размер для футера, ключ i18n для aria-label.
- Нужен ли отдельный рендер в `chat-window.tsx` или достаточно `chat-message.tsx`.

## Next Epoch Focus
- Прочитать kit-источник `CopyButton`, проверить рендер в `chat-window.tsx`, ключи i18n, канон DESIGN.
