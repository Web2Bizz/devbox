# Epoch 1: Coarse hypothesis

## Hypothesis
- Footer `MessageFooter` в `apps/frontend/src/components/chat/chat-message/chat-message.tsx` сейчас: fork/revert — текстовые `Button` (ghost/sm), copy — китовый `CopyButton` (ghost/icon) с hover-фоном от кита.
- Цель: revert → иконка `History` (откат к снапшоту), fork → иконка `GitFork` (ветвление), copy — убрать hover-фон через `hover:bg-transparent`.
- `lucide-react` напрямую во фронтенде не задекларирован — импорт взять либо из новой прямой зависимости, либо из транзитивной; проверить.

## Evidence Found
- File: `apps/frontend/src/components/chat/chat-message/chat-message.tsx:196-234` — `CopyButton variant="ghost" size="icon" className="text-muted-foreground"`; fork/revert `Button variant="ghost" size="sm"` с текстовым `{t.chat.fork}` / `{t.chat.revert}`, `aria-label`/`title`/`data-testid` уже есть.
- File: `apps/frontend/package.json` — зависимостей `lucide-react` нет (только `@web2bizz/ui 0.26.3`, `next ^16.3.6`, `react ^19.2.4`).
- Pattern: `FEEDBACK_TOGGLE_CLASS = 'bg-transparent text-muted-foreground hover:bg-transparent'` (строка 51) — уже доказанный приём перебивки kit-hover через `cn`+tailwind-merge; тот же приём применим к copy.

## Decisions
- Decision: пока ничего не меняем в коде, только фиксируем гипотезу.
- Alternatives considered: нет.

## Confirmed Plan Items
1. Замена иконок + hover копирования — reason: целевой вид footer, artifact: `chat-message.tsx`, validation: `bun run lint`.

## Open Questions
- Откуда брать `History`/`GitFork`: прямая зависимость vs транзитив кита? Какая версия lucide?
- Точный `className` для copy (нужен ли `focus-visible:bg-transparent`)?

## Next Epoch Focus
- Evidence gathering: версия lucide в ките, наличие иконок, устройство `CopyButton` (слияние className), выбор fallback-иконки.
