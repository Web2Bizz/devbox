# Epoch 1: Coarse hypothesis

## Hypothesis
- `chat-window.tsx` — монолит: grid + высоты `h-[calc(100dvh_-_9rem)]` + отступ под Header `pt-[calc(var(--header-height)_+_1rem)]` + ветки (loading/error/empty/thread) + инлайн thinking/streaming ряды. Нарушает CODE_OF_CONDUCT §2 (геометрия в компоненте) и §3 (россыпь 8 файлов в `chat-window/`).
- Уже существует плоская фича `src/features/chat-thread.tsx` (дубль ChatWindow на внешних row-компонентах) + shim `chat-window/index.ts` (`export { ChatThread as ChatWindow }`), а старый `chat-window.tsx` (9.4КБ, `ChatWindowProps`, инлайн thinking/streaming) всё ещё лежит рядом — мёртвый дубль, визуал идёт через новый путь.
- `src/features/chat/` (chat-section/fork/revert + __tests__) — вложенный каталог, нарушение §1 features-flat. Аналогично `src/features/usage/` — вне скоупа, не трогаем.
- Сегмент `sessions/[sessionId]/layout.tsx` отсутствует (только `page.tsx` 'use client' + `useParams`); геометрия пина композера (`absolute bottom-2 ... z-20`) живёт в `chat-section.tsx` — нарушение §2 (фича задаёт пин).
- Визуал правильный сейчас, задача — только rekomпозиция без визуальной регрессии: underlap треда под Header (`Content variant=chat`: `grid-area 1/2/-1/3`, `z-0`, Header `z-30`), скролл внутри Content, композер `z-20` под Header.

## Evidence Found
- Каноны заявлены пользователем, не проверены в коде на этой эпохе: `apps/frontend/AGENTS.md`, `CODE_OF_CONDUCT.md` §§1-3, `DESIGN.md` + `apps/frontend/DESIGN.md` §3 реестр, §5.1 `data-shell-variant=chat`.

## Decisions
- Пока ничего не решено; гипотеза требует проверки чтением файлов.

## Confirmed Plan Items
1. Декомпозировать chat-window → страница + фича + тред-виджет + ряды + live-статус — гипотеза, требует доказательств.

## Open Questions
- Точный состав `chat-window/` (8 файлов)? Содержимое `chat-thread.tsx` vs `chat-window.tsx`? Где `chat-section.tsx` и его геометрия? Есть ли `layout.tsx` сегмента? Какие `types.ts/index.ts` отсутствуют? Как устроен `Content variant=chat` + `DashboardShell chatLayer`?

## Next Epoch Focus
- Epoch 2: прочитать все файлы, зафиксировать конкретные пути/пропсы/классы (evidence gathering).
