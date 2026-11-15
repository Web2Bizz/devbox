# PLAN.md — Замена иконок + hover копирования (opal-fork-k2)

> Корень: `/media/codebase/@web2bizz/devbox`, ветка `feat/cli-cloud-chat`.
> Scope: только `MessageFooter` в `apps/frontend/src/components/chat/chat-message/chat-message.tsx`. depth=low (2 эпохи).

## Карточка 1/1 — footer-иконки + hover copy [low / low]

**Что сделать**
- [ ] 1. `apps/frontend/package.json`: добавить `lucide-react: ^0.577.0` в dependencies (align с `@web2bizz/ui 0.26.3`), выполнить `bun install`.
- [ ] 2. `chat-message.tsx` (импорт, ~строка 13): `import { GitFork, History } from 'lucide-react';`
- [ ] 3. Fork-кнопка (~строки 207–220): оставить `Button variant="ghost" size="sm"`, `aria-label={t.chat.forkBefore}`, `title`, `data-testid="chat-message-fork"`, `onClick`; тело `{t.chat.fork}` → `<GitFork size={16} aria-hidden="true" />`. (Если `GitFork` нет в версии — fallback `GitBranch`, затем `Split`.)
- [ ] 4. Revert-кнопка (~строки 221–234): аналогично, тело `{t.chat.revert}` → `<History size={16} aria-hidden="true" />`; `aria-label={t.chat.revert}`, `title`, `data-testid="chat-message-revert"`, `onClick` без изменений.
- [ ] 5. Copy (~строки 196–206): `CopyButton` оставить `variant="ghost" size="icon"`, `className="text-muted-foreground hover:bg-transparent"`; `aria-label`/`title`/`data-testid="chat-message-copy"` без изменений. При остаточном keyboard-focus фоне — добавить `focus-visible:bg-transparent`.
- [ ] 6. `bun run lint` в `apps/frontend` — чисто (tsc --noEmit + biome exit 0). Без hex, variant кита не менять, только footer.

**Критерии приёмки**
- Footer показывает иконки History (revert) / GitFork (fork) вместо текста; copy без hover-фона.
- a11y (`aria-label`/`title`) и `testid` (`chat-message-copy/fork/revert`) сохранены.
- `bun run lint` чист.

**Не делать**
- Не трогать feedback-тогглы, bubble, `FEEDBACK_TOGGLE_CLASS`, другие файлы.
- Не менять variant кита, не вводить hex-цвета, не импортировать из транзитива кита.
