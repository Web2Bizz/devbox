# Epoch 2: Evidence gathering

## Hypothesis
Гипотеза Epoch 1 подтверждается чтением кода.

## Evidence Found
- `src/components/chat/chat-window/` — 8 файлов россыпью (нарушение §3):
  - `chat-window.tsx` (225 строк, `ChatWindowProps`: messages/streamingText/loading/sending/error/onRetry/toolTrace/activeAgentName/activeToolName/onFork/onRevert; инлайн thinking `AgentThinking+Badge` + streaming `Message/Bubble/ShimmerText`; высоты `h-[calc(100dvh_-_9rem)]`, `pt-[calc(var(--header-height)_+_1rem)]`) — СТАРЫЙ монолит, мёртвый;
  - `agent-thinking.tsx` (`AgentThinkingProps`: activeAgentName?/activeToolName?; `ShimmerText` live `agent · tool` или ротация `t.chat.thinking` 1.6с);
  - `chat-thinking-row.tsx` (`ChatThinkingRowProps`: те же 2 опц. поля; `Badge` строки);
  - `chat-streaming-row.tsx` (`ChatStreamingRowProps`: streamingText + 2 опц.; ghost Bubble + курсор `▍` + `ShimmerText` статус);
  - `chat-thread-empty.tsx` (без пропсов; `h-[calc(100dvh_-_9rem)]` + `pt-[calc(...header...)]` + `EmptyState`);
  - `chat-thread-loading.tsx` (без пропсов; 3× `Skeleton h-16`);
  - `chat-tools-timeline.tsx` (`ChatToolsTimelineProps`: events: ChatToolEvent[] + liveToolName?: string|null; `Collapsible+Badge`);
  - `index.ts` (реэкспорт 6 модулей + shim `export { ChatThread as ChatWindow }` + type alias — `chat-window.tsx` уже НЕ реэкспортируется).
- `src/features/chat-thread.tsx` (108 строк, `ChatThreadProps` = тот же шейп что `ChatWindowProps`): ветки loading→`<ChatThreadLoading/>`, error-empty→инлайн `ErrorState`, empty→`<ChatThreadEmpty/>`, thread→`MessageScrollerProvider autoScroll defaultScrollPosition=end > MessageScroller h-[calc(100dvh_-_9rem)] > Viewport > Content gap-1 pt-[calc(header+1rem)]` + Items (message→`ChatMessageRow`, timeline→обычный item без scrollAnchor, thinking/streaming→`scrollAnchor`).
- `src/features/chat/chat-section.tsx` (187 строк, `ChatSectionProps`: sessionId?/projectId?): `useChat` + `agentsQuery` + `?agent=` URL-синк + lazy-create replace; `<section grid gap-2>` → `<ChatThread ... onFork/onRevert>` + пин композера `<div absolute bottom-2 right-[calc((100%-300px)*0.25)] z-20 bg-background m-auto w-[50%]>` → `<ChatInput onSend/onStop leftSlot=<AgentSelector/>>` + 2 диалога. Геометрия пина В ФИЧЕ — нарушение §2.
- `src/features/chat/chat-fork-dialog.tsx` (`ChatForkDialogProps`: open/onOpenChange/sessionId/projectId/messageId) + `chat-revert-dialog.tsx` (тот же шейп; stage/commit/clear) — кандидаты на уплощение.
- `src/components/chat/chat-message/chat-message.tsx` (`ChatMessageRow`: message: ChatMessage + onFork?/onRevert?; kit Message/Bubble/MessageText + fence-split + footer like/dislike/copy/fork/revert) — есть `index.ts`, НЕТ `types.ts`. То же `chat-input/` (`ChatInputProps`: onSend/onStop?/sending?/placeholder?/leftSlot?; kit PromptInput) и `agent-selector/` (`AgentSelectorProps`: agentId/onChange/disabled?) — НЕТ `types.ts` нигде в `components/chat/*`.
- `app/organizations/[orgId]/projects/[projectId]/sessions/[sessionId]/` — ТОЛЬКО `page.tsx` ('use client', `useParams` pick sessionId/projectId → `<ChatSection/>`), `layout.tsx` ОТСУТСТВУЕТ. Легаси `(dashboard)/projects/[id]/sessions/[sessionId]/page.tsx` — 410-интерцептор (не трогаем). `(dashboard)/chat/*` — redirect → /organizations (не трогаем).
- Шелл: `DashboardShell` ('use client', `usePathname` → `chatLayer = /\/sessions\/[^/]+\/?$/` → `data-shell-variant=chat` + `<Content variant=chat>`); `Content.tsx` chat → `z-0 border-0 bg-transparent [grid-area:1/2/-1/3]` + inner `pt-2 pb-2`; Header `sticky top-0 z-30`; DESIGN §5.1: панель тянется под Header, `padding-top: calc(var(--header-height)+1rem)` (реально `pt` несёт Content треда внутри скроллера).
- Контроли сейчас: `find src/features -mindepth 2` → ПЕЧАТАЕТ `chat/*` + `usage/*` (нарушение §1); `grep h-[calc(100dvh` → `features/chat-thread.tsx:62,76` + `chat-window.tsx:108,121,131` + `chat-thread-empty.tsx:9` (нарушение §2); все `components/chat/*/types.ts` отсутствуют; `index.ts` есть везде.

## Decisions
- Пока без решений; фактура собрана.

## Confirmed Plan Items
1. Инвентаризация завершена — 8 файлов chat-window + 3 файла features/chat + 1 flat chat-thread + page без layout — факт, источник: листинг + чтение.
2. Дубль ChatWindow/ChatThread (одинаковый `Props`-шейп, shim в index.ts) — факт.

## Open Questions
- Куда отнести скроллер: оставить `features/chat-thread.tsx` (фича владеет порядком) или вынести в `components/chat/chat-thread/` (виджет)? Как поделить геометрию layout vs feature vs component? Имя live-виджета (`agent-thinking` vs `chat-live-status`)? Реестр DESIGN §3 — какие имена удалить/добавить?

## Next Epoch Focus
- Epoch 3: превратить факты в решения — целевая карта было→стало, владение геометрией, реестр.
