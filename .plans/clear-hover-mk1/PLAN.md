# PLAN — Единый hover-фон футера чата («прозрачный всем»)

- Plan dir: `.plans/clear-hover-mk1/` (epochs 01–03)
- Root: `/media/codebase/@web2bizz/devbox`, branch: `feat/cli-cloud-chat`
- Depth: low (1 карточка, low/low) — только план, без реализации.

## Цель
Всем кнопкам футера `MessageFooter` в `apps/frontend/src/components/chat/chat-message/chat-message.tsx` — `hover:bg-transparent focus-visible:bg-transparent`. Без hex, без смены variant.

## Контекст/опоры
- `FEEDBACK_TOGGLE_CLASS` (строка 52) — like/dislike, override kit `toggleVariants hover:bg-accent` через `cn`/tailwind-merge (комментарий строки 44-51).
- `CopyButton` (строка 202) — эталон, уже `text-muted-foreground hover:bg-transparent focus-visible:bg-transparent`.
- Fork (строка 213) / Revert (строка 227) — `Button variant="ghost" className="h-7 px-2 text-xs text-muted-foreground"`, прозрачности нет.
- Тесты `src/components/chat/__tests__/chat-window.test.tsx` ассертят только testid/структуру, не классы — смена классов безопасна.

## Шаги (последовательно, 1 файл)

### 1. Like/Dislike — дописать focus-visible
- Файл: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:52`
- Было: `'bg-transparent text-muted-foreground hover:bg-transparent'`
- Стало: `'bg-transparent text-muted-foreground hover:bg-transparent focus-visible:bg-transparent'`
- Плюс: в комментарии над константой (строки 44-51) добавить упоминание `focus-visible:bg-transparent`.
- Проверка: `rg "FEEDBACK_TOGGLE_CLASS|focus-visible:bg-transparent" apps/frontend/src/components/chat/chat-message/`

### 2. Fork — дописать hover/focus
- Файл: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:213` (Button `data-testid="chat-message-fork"`)
- Было: `"h-7 px-2 text-xs text-muted-foreground"`
- Стало: `"h-7 px-2 text-xs text-muted-foreground hover:bg-transparent focus-visible:bg-transparent"`
- Не менять: `variant="ghost"`, `size="sm"`, `aria-label`/`title`/`data-testid`/`onClick`.
- Проверка: `rg "hover:bg-transparent" apps/frontend/src/components/chat/chat-message/chat-message.tsx` — 4 попадания (2×toggle через константу + copy + fork + revert → по строкам 5 вхождений с учётом дефиниции).

### 3. Revert — дописать hover/focus
- Файл: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:227` (Button `data-testid="chat-message-revert"`)
- Было/стало: аналогично шагу 2.
- Не менять: `variant="ghost"`, `size="sm"`, `aria-label`/`title`/`data-testid`/`onClick`.

### 4. Copy — проверить без изменений
- Файл: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:202`
- Ожидаемо: `className="text-muted-foreground hover:bg-transparent focus-visible:bg-transparent"` уже на месте; если да — не трогать.

### 5. Валидация
- `bun run lint` (tsc --noEmit + biome lint) — exit 0.
- Ручная проверка: hover и keyboard-focus (Tab) у like/dislike/copy/fork/revert визуально одинаковые (прозрачные), selected-state `data-[state=on]:bg-accent` у toggles на месте.
- a11y/testid: `aria-label`, `title`, `data-testid` (copy/fork/revert, like/dislike) сохранены.

## Не делать
- Не менять `variant`/`size`/`type`, структуру `MessageFooter`, логику `feedback`/`onFork`/`onRevert`.
- Не вводить hex-цвета, новые CSS-файлы, общие константы для Button.
- Не трогать другие файлы (scope = 1 файл).

## Trello-карточка (1 шт, low/low)
- Название: «Чат: единый прозрачный hover/focus кнопок футера»
- Описание: шаги 1–5 + файл/строки выше.
- Чек-лист: [ ] toggle-класс+комментарий; [ ] fork; [ ] revert; [ ] copy проверен; [ ] lint чист; [ ] hover/focus одинаковые; [ ] testid/a11y на месте.
