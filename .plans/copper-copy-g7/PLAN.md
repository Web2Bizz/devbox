# PLAN: Кнопка «копировать» под сообщением ИИ (CopyButton из @web2bizz/ui)

- Корень: `/media/codebase/@web2bizz/devbox`, ветка `feat/cli-cloud-chat`
- Кит: `@web2bizz/ui 0.26.3` (установлен; источник `/media/codebase/@web2bizz/ui/src/widgets/copy-button/`)
- Эволюция: `.plans/copper-copy-g7/epoch-01.md` → `epoch-02.md` (low depth, стоп — конфликтов нет)

## Карточка C1 — Добавить CopyButton под assistant-сообщением (impl)

**Что сделать:** в `apps/frontend/src/components/chat/chat-message/chat-message.tsx`, в assistant-ветке `MessageFooter` (`{!isUser && ...}`), отрендерить kit-`CopyButton` с `content={message.text}`. Только для `role === 'assistant'`. `chat-window.tsx` не трогать (там только `<ChatMessageRow>`).

**Импорт (к существующим из widgets):**
```ts
import { CopyButton } from '@web2bizz/ui/widgets';
```

**Рендер (позиция — в assistant-`MessageFooter`, до/после like/dislike, до fork/revert):**
```tsx
{!isUser && (
  <CopyButton
    content={message.text}
    variant="ghost"
    size="icon"
    className="text-muted-foreground"
    aria-label={t.chat.copy ?? t.copy ?? 'Copy'}
    title={t.chat.copy ?? t.copy ?? 'Copy'}
    data-testid="chat-message-copy"
  />
)}
```
Допуски исполнителю: `size="sm"` вместо `"icon"` если визуально выбивается; `delay`/`copied` не трогать (неконтролируемый режим, default 3000). Существующий `sr-only "Copy content"` и анимация Copy→Check — из кита, не дублировать.

**Чек-лист:**
- [ ] Импорт `CopyButton` из `@web2bizz/ui/widgets` (не свой компонент, не `navigator.clipboard` напрямую)
- [ ] Кнопка только под assistant (`!isUser`), копирует `message.text` целиком
- [ ] copy→copied из кита (без локального `useState`), a11y из кита + `aria-label/title` из i18n
- [ ] Стили только токены (`text-muted-foreground`), hex нет; порядок стилей не меняется (`@web2bizz/ui/styles.css` → `globals.css`)
- [ ] `chat-window.tsx` без изменений (проверить, что дублирующего рендера нет)
- [ ] Существующие тесты чата не сломаны (`apps/frontend/src/components/chat/__tests__/chat-window.test.tsx` — при наличии селекторов футера)

**Complexity / риск:**
- Complexity: **low** (1 файл, +~10 строк, существующий API кита, dipakai-паттерн widgets уже в файле)
- Риск: **low** (score ~1–2/8; факторы: нет — no breaking, no data, no security, no external; fallback буфера обмена внутри кита)

## Карточка C2 — Проверки и done (verify)

**Что сделать:** прогнать гейты, зафиксировать результат.

**Чек-лист:**
- [ ] `bun run lint` — чисто
- [ ] `next build --turbopack` в `apps/frontend` — чисто
- [ ] guard `no-opencode-transport` — чисто (новых транспортов/флагов нет)
- [ ] Ручная проверка: assistant-сообщение → клик copy → иконка Check → через ~3с возврат; вставка даёт `message.text`

**Done (обе карточки):** кнопка из кита под текстом assistant, копирует текст сообщения, состояния и a11y из кита, без hex, `chat-window.tsx` не тронут, все три проверки зелёные.

## Файлы (точные)
1. `apps/frontend/src/components/chat/chat-message/chat-message.tsx` — единственное изменение (C1)
2. `apps/frontend/src/components/chat/chat-window/chat-window.tsx` — read-only, изменений нет
3. `apps/frontend/src/components/chat/__tests__/chat-window.test.tsx` — read-only, регресс
4. `/media/codebase/@web2bizz/ui/src/widgets/copy-button/copy-button.tsx` — read-only референс API
5. `/media/codebase/@web2bizz/ui/src/widgets/copy-button/types.ts` — read-only референс пропсов
6. `/media/codebase/@web2bizz/ui/src/widgets.ts` — read-only подтверждение экспорта
7. `apps/frontend/src/i18n/dictionaries/en.ts` — read-only, ключ `copy` (строка 35)

## Не делать
- Свой CopyButton/useCopy/`navigator.clipboard` в `apps/frontend`
- Controlled `copied`-state, кастомные иконки/hex/цвета, изменения `chat-window.tsx`, новые i18n-ключи без нужды
