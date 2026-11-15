# Epoch 4: Refinement — было→стало, пропсы, сетка

## Hypothesis
Детализация D1–D6 до уровня файлов и классов без изменения визуала.

## Evidence Found
- Текущие классы-носители геометрии (источник регрессии при переносе): тред `h-[calc(100dvh_-_9rem)] min-h-[20rem]` (MessageScroller) + `pt-[calc(var(--header-height)_+_1rem)]` (Content/empty/loading/error); композер `absolute bottom-2 right-[calc((100%-300px)*0.25)] z-20 bg-background m-auto w-[50%]`; шелл `Content variant=chat: z-0 [grid-area:1/2/-1/3]` + Header `z-30`; скролл `overflow-y-auto` в Content + `overscroll-contain`.
- Пропсы-шейпы (из Epoch 2): `ChatThreadProps`/`ChatWindowProps` идентичны (9 полей); row-пропсы минимальны (2–3 поля); `ChatInputProps`/`AgentSelectorProps` стабильны.

## Decisions
- Decision D7 (сетка layout, Server): новый `app/organizations/[orgId]/projects/[projectId]/sessions/[sessionId]/layout.tsx`:
  ```tsx
  // Server, без 'use client'. Владеет grid + высотами + пином.
  <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-2">
    <div className="min-h-[20rem] min-w-0">{children /* тред: скролл внутри, pt под Header */}</div>
    <div className="sticky bottom-2 z-20 mx-auto w-[50%] bg-background">{composerSlot}</div>
  </div>
  ```
  Уточнение пина: `absolute bottom-2 right-[calc((100%-300px)*0.25)] w-[50%]` (текущий, привязан к viewport+сайдбар) → заменить на `sticky bottom-2 mx-auto w-[50%]` внутри grid-строки layout (тот же визуал, но без viewport-magic, ресайз сайдбара не ломает). `right-[calc...]` НЕ переносить. z: композер `z-20` < Header `z-30`, тред `z-0` (наследует Content chat). Underlap: `pt-[calc(var(--header-height)_+_1rem)]` остаётся на `MessageScrollerContent` (внутри скролла), скролл-контейнер — `MessageScroller` + `Content overflow-y-auto`. Alternatives: сохранить `absolute` — rejected (ломает §2 «пин в layout, но предсказуемый»; absolute к viewport зависит от 300px сайдбара).
- Decision D8 (карта было→стало):
  | Было | Стало | Тип операции |
  |---|---|---|
  | `components/chat/chat-window/chat-window.tsx` (ChatWindow, 9 полей) | УДАЛИТЬ (оркестрация переезжает в `chat-thread/ChatThread`) | delete |
  | `components/chat/chat-window/index.ts` (shim) | УДАЛИТЬ вместе с папкой | delete |
  | `components/chat/chat-window/agent-thinking.tsx` (AgentThinking) | `components/chat/chat-live-status/ChatLiveStatus.tsx` + `types.ts` + `index.ts` | move+rename |
  | `.../chat-thinking-row.tsx` | `components/chat/chat-thinking-row/ChatThinkingRow.tsx` + `types.ts` + `index.ts` | move |
  | `.../chat-streaming-row.tsx` | `components/chat/chat-streaming-row/ChatStreamingRow.tsx` + `types.ts` + `index.ts` | move |
  | `.../chat-thread-empty.tsx` | `components/chat/chat-thread-empty/ChatThreadEmpty.tsx` + `types.ts` + `index.ts` | move |
  | `.../chat-thread-loading.tsx` | `components/chat/chat-thread-loading/ChatThreadLoading.tsx` + `types.ts` + `index.ts` | move |
  | `.../chat-tools-timeline.tsx` (ChatToolsTimeline) | `components/chat/chat-tool-timeline/ChatToolTimeline.tsx` + `types.ts` + `index.ts` (имя папки/компонента в ед.ч. по AGENTS-канону `chat-tool-timeline/`) | move+rename |
  | `features/chat-thread.tsx` (ChatThread, с геометрией) | `components/chat/chat-thread/ChatThread.tsx` + `types.ts` + `index.ts` (без `h-[calc(100dvh)]`, высоту берёт из layout через `className`) | move (feature→component) |
  | `features/chat/chat-section.tsx` | `features/chat-section.tsx` (плоско; `className?: string` от layout; без `absolute`/высот; композиция ChatThread + ChatInput + диалоги) | move (flatten) |
  | `features/chat/chat-fork-dialog.tsx` | `features/chat-fork-dialog.tsx` | move (flatten) |
  | `features/chat/chat-revert-dialog.tsx` | `features/chat-revert-dialog.tsx` | move (flatten) |
  | `features/chat/__tests__/chat-section-url.test.tsx` | `features/__tests__/chat-section-url.test.tsx` (или рядом плоско) | move |
  | `components/chat/chat-message/chat-message.tsx` (типы инлайн) | + `chat-message/types.ts` (`ChatMessageRowProps`) + правка импорта | add types |
  | `components/chat/chat-input/chat-input.tsx` | + `chat-input/types.ts` (`ChatInputProps`) | add types |
  | `components/chat/agent-selector/agent-selector.tsx` | + `agent-selector/types.ts` (`AgentSelectorProps`) | add types |
  | `app/.../sessions/[sessionId]/page.tsx` ('use client') | тонкий Server `page.tsx` (params → `<ChatSection/>`) | rewrite |
  | НОВЫЙ `app/.../sessions/[sessionId]/layout.tsx` | Server grid владелец | create |
  | `components/chat/index.ts` | убрать `export * from './chat-window'` → `export * from './chat-thread'` + новые папки | edit |
  | `__tests__/chat-window.test.tsx` | `chat-thread/__tests__/` или `chat-thread.test.tsx` рядом с виджетом + обновить импорты | move+edit |
- Decision D9 (пропсы/типы, только `export type` в `types.ts`, без `interface`):
  - `chat-thread/types.ts`: `ChatThreadProps` (9 полей как сейчас: messages: ChatMessage[]; streamingText: string; loading?; sending?; error?: string|null; onRetry?; toolTrace?: ChatToolEvent[]; activeAgentName?; activeToolName?; onFork?; onRevert?; + `className?: string` от layout).
  - `chat-thinking-row/types.ts`: `ChatThinkingRowProps { activeAgentName?; activeToolName? }`; `chat-streaming-row/types.ts`: `{ streamingText: string; activeAgentName?; activeToolName? }`; `chat-live-status/types.ts`: `ChatLiveStatusProps { activeAgentName?; activeToolName? }` (бывш. AgentThinkingProps); `chat-tool-timeline/types.ts`: `{ events: ChatToolEvent[]; liveToolName?: string|null }`; empty/loading — `Record<string, never>` или без types (пустые пропсы → `types.ts` с `export type XProps = Record<string, never>` чтобы контроль `types.ts` сошёлся, либо без пропсов но файл-обязателен по §3 — держим пустой type).
  - `ChatMessageRowProps` / `ChatInputProps` / `AgentSelectorProps` — вынести из `.tsx` в свои `types.ts` без изменения шейпа.
  - `ChatSectionProps` остаётся в `features/chat-section.tsx` (фича плоская, типы рядом допустимы — не компонентная папка).

## Confirmed Plan Items
1. Карта было→стало (17 строк) — решение D8, артефакт: таблица выше, валидация: `find` + `ls` после.
2. Сетка layout (grid rows, sticky пин z-20, underlap pt, Header z-30) — решение D7, валидация: визуальное сравнение + `grep` отсутствие геометрии в features/components.
3. Пропсы/типы по папкам — решение D9.

## Open Questions
- Совместимость с тестами и реестром DESIGN §3 (точные имена удалить/добавить)? Порядок шагов (что первым — layout или компоненты)? Контроли-lint/build?

## Next Epoch Focus
- Epoch 5: валидация против канонов + реестр + тесты + контроли.
