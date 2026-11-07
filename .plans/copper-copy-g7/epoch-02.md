# Epoch 2: Evidence → decisions

## Hypothesis
- Одной карточки на имплементацию + одной на проверку достаточно (тривиальное изменение одного файла, риск низкий).

## Evidence Found
- File: `/media/codebase/@web2bizz/ui/src/widgets/copy-button/copy-button.tsx` — `CopyButton({content, copied?, onCopiedChange?, delay=3000, onClick?, disabled?, variant='outline', size='icon', ...props})`; внутри `Button` + `writeToClipboard(content)` + автозатухание `copied` через timeout + иконки `CopyIcon/CheckIcon` с `motion` + `<span className="sr-only">Copy content</span>`.
- File: `/media/codebase/@web2bizz/ui/src/widgets/copy-button/utils.ts` — `writeToClipboard`: `navigator.clipboard.writeText` → fallback скрытый `textarea` + `execCommand('copy')`.
- File: `/media/codebase/@web2bizz/ui/src/widgets/copy-button/types.ts` — `CopyButtonProps = Omit<ButtonProps,'children'> & {content: string; ...}` → значит `aria-label/title/className/data-testid` прокидываются в kit-`Button` через `...props`.
- File: `/media/codebase/@web2bizz/ui/src/widgets.ts:23` — `export * from './widgets/copy-button'` → импорт потребителем: `import { CopyButton } from '@web2bizz/ui/widgets'`.
- File: `apps/frontend/src/components/chat/chat-window/chat-window.tsx` — только вызывает `<ChatMessageRow message onFork onRevert>` (подтверждено grep: `ChatMessageRow` используется в `chat-window.tsx` и `chat-message.tsx`); отдельного рендера текста assistant там нет → правка только в `chat-message.tsx`.
- File: `apps/frontend/src/i18n/dictionaries/en.ts:35` — есть `copy: 'Copy'`; `chat.*`: `like/dislike/fork*/revert*` (300–322), `copyLink: 'Copy link'` (366). Точного `chat.copy` нет → aria-label взять из существующего ключа (`t.chat.copy` если есть в типе, иначе соседний `copy`), новый словарь не заводить без нужды.
- Pattern: `DESIGN.md` (корень) + `apps/frontend/DESIGN.md:43,160` — hex только в `:root/.dark` (`globals.css`); порядок стилей `@web2bizz/ui/styles.css` → `globals.css`; в прикладном коде только токены (`text-muted-foreground` и т.п.).
- Pattern: существующий `MessageFooter` assistant-ветки: `className='mt-1'`, like/dislike через `FEEDBACK_TOGGLE_CLASS='bg-transparent text-muted-foreground hover:bg-transparent'`, fork/revert `Button variant=ghost size=sm className='h-7 px-2 text-xs text-muted-foreground'`.

## Decisions
- Decision: `content={message.text}` (полный текст сообщения, не отрендеренные блоки) — копируется то, что пришло от ИИ.
- Alternatives considered: копировать только text-блоки без fences (отклонено — расходится с источником, усложняет без требования).
- Decision: неконтролируемый режим (`copied` не прокидывать, `delay` по умолчанию 3000) — локального `useState` не добавлять; kit сам держит copy→copied.
- Alternatives considered: controlled `copied` + свой state (отклонено — лишний state без требования синхронизации).
- Decision: `variant="ghost" size="icon"` (или `size="sm"` если `icon` визуально крупнее соседей — решить по месту одним пропсом) + `className="text-muted-foreground"` + `aria-label/title` из i18n + `data-testid="chat-message-copy"`. Без кастомных hex/цветов.
- Decision: позиция — первым элементом assistant-`MessageFooter` (до like/dislike) ИЛИ сразу после ToggleGroup, до fork/revert; только для `!isUser`.
- Decision: правок `chat-window.tsx` не требуется (там нет дублирующего рендера).
- Decision: 2 карточки — C1 имплементация, C2 проверка (линт+билд+guard). Однофайловое изменение,.merge в ветке `feat/cli-cloud-chat`.

## Confirmed Plan Items
1. Импорт + рендер `CopyButton` в assistant-`MessageFooter` (`chat-message.tsx`) — widgets-канал, ghost-вариант, токены.
2. Проверки: `bun run lint` + `next build --turbopack` (в `apps/frontend`) + guard `no-opencode-transport` — без них done нет.

## Open Questions
- Нет открытых вопросов. Мелочь на усмотрение исполнителя: `size="icon"` vs `"sm"` по визуалу; точный i18n-ключ `copy` (тип `t.chat` подскажет).

## Next Epoch Focus
- Синтез в `PLAN.md` (карточки, чек-листы, complexity/риск, done). Epoch 3 не требуется (low depth).
