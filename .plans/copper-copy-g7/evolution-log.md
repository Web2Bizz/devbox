# Evolution log — copper-copy-g7

## Epoch 1 — Coarse hypothesis
- Гипотеза: кнопка = kit-CopyButton в `MessageFooter` assistant-ветки `chat-message.tsx`.
- Основание: файл уже сидит на `@web2bizz/ui/widgets`; кит 0.26.3 установлен.
- Статус: подтверждено.

## Epoch 2 — Evidence → decisions
- Доказано: `CopyButton` существует (`src/widgets/copy-button/`), экспортируется из `widgets.ts:23`, пропсы `{content, copied?, onCopiedChange?, delay=3000, variant, size}` + `ButtonProps` (aria/className/testid прокидываются); `writeToClipboard` с textarea-fallback; `chat-window.tsx` только вызывает `ChatMessageRow` (правка не нужна); i18n `copy` есть (en.ts:35), `chat.copy` — уточнить по типу; DESIGN-канон: hex только `:root/.dark`, токены в коде.
- Решения (все финальные, superseded нет):
  1. `content={message.text}`, неконтролируемый режим — вместо копирования блоков/controlled-state.
  2. `variant="ghost"`, только `!isUser`, позиция в assistant-`MessageFooter` — вместо outline/своих стилей.
  3. 2 карточки (impl + verify), 1 файл изменений — вместо дробления.
- Конфликтов не было; Epoch 3 не открывался (low depth).
- Финал: `PLAN.md` (C1 impl, C2 verify, complexity low / риск low).
