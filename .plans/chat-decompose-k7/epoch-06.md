# Epoch 6: Implementation specifics — порядок шагов

## Hypothesis
Работу можно выполнить за 8 атомарных шагов без визуальной регрессии (каждый шаг — зелёные контроли).

## Evidence Found
- Зависимости: тред зависит от рядов+live+timeline; фича зависит от треда+инпута+диалогов; layout/page зависят от фичи; барелли/реестр/тесты — замыкают. Параллелить нельзя: сначала листья (ряды), потом тред, потом фича-flatten, потом layout/page, потом удаление, потом реестр+тесты+контроли.

## Decisions
- Decision D13 (порядок, каждый шаг = отдельный коммит):
  - Шаг 1 — Листья §3: создать 6 папок (`chat-thinking-row, chat-streaming-row, chat-thread-empty, chat-thread-loading, chat-tool-timeline, chat-live-status`) с `<Имя>.tsx` (move без логики) + `types.ts` (вынести Props) + `index.ts`; добавить `types.ts` в `chat-message/ chat-input/ agent-selector/` (вынести Props, в `.tsx` только `import type ... from './types'`). Проверка: §3-цикл молчит, `tsc` зелёный.
  - Шаг 2 — Виджет треда: создать `chat-thread/ChatThread.tsx + types.ts + index.ts` переносом `features/chat-thread.tsx` БЕЗ классов `h-[calc(100dvh...)]` (заменить на `className?: string` + внутренний `min-h-[20rem]`; `pt-[calc(header+1rem)]` на Content ОСТАВИТЬ — это underlap, не высота маршрута), импорты рядов — на новые папки. `features/chat-thread.tsx` пока оставить (дубль) — удалить на шаге 5.
  - Шаг 3 — Фича flatten: `features/chat/chat-section.tsx → features/chat-section.tsx` (импорты `ChatThread`→`@/components/chat/chat-thread`, диалоги→`@/features/chat-fork-dialog`; убрать `absolute`-пин композера → `<div className={composerClassName}>` получаемый через проп от layout, временно default = старый класс); `chat-fork-dialog/chat-revert-dialog → features/*.tsx`; тест URL → `features/__tests__/`. Проверка: `find -mindepth 2` по `features/chat` пуст.
  - Шаг 4 — Layout+page: создать Server `layout.tsx` (grid D7, `export default function SessionChatLayout({ children, composer }: ...)` — composer через parallel slot или проп `composer` от page; простейшее: layout владеет grid, page кладёт `<ChatSection className composerClassName>`), переписать `page.tsx` в Server (`await params` → `<ChatSection sessionId projectId>`). Убрать 'use client'/`useParams`.
  - Шаг 5 — Резка: удалить `features/chat-thread.tsx` (дубль), удалить `components/chat/chat-window/` целиком (`chat-window.tsx` + `index.ts` + 6 старых файлов уже переехали — папка пуста), обновить `components/chat/index.ts`. Проверка: `ls chat-window` → no such dir; `grep -r ChatWindow src app` → пусто (кроме истории/плана).
  - Шаг 6 — Фича дотяжка: убрать из `chat-section.tsx` дефолтный `absolute`-класс (пин только из layout), прокинуть `className` в `ChatThread`; убедиться `grep h-[calc` + `grep absolute.*bottom` по features/components пусты.
  - Шаг 7 — Реестр+тесты: DESIGN §3.2/§3.3 + AGENTS-структура (D10, требует human approve), тест chat-window→chat-thread (D11), барелли (D12).
  - Шаг 8 — Контроли: полный прогон (см. Epoch 7).
- Decision D14 (что НЕ делать): не трогать `DashboardShell/Content/globals.css` (z-30/underlap уже верны), не трогать `usage/` вложенность (долг вне скоупа), не переименовывать `ChatMessageRow/AgentSelector` (реестр правится, не код), не менять `useChat`/SSE/API/i18n.

## Confirmed Plan Items
1. 8 шагов с проверками — решение D13.
2. Stop-лист — решение D14.

## Open Questions
- Финальный чек-лист команд и критерии приёмки?

## Next Epoch Focus
- Epoch 7: финальные контроли (команды дословно), приёмка, риски.
