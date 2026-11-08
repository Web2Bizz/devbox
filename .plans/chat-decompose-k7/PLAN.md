# PLAN — декомпозиция chat-window (frontend, Next.js)

> Директория плана: `.plans/chat-decompose-k7/`. Эпохи: `epoch-01..07.md`. Без реализации — только план.
> Цель: `chat-window.tsx` прекращает существование; визуал 1:1; композиция по канонам.

## 0. Каноны (источники правды)

- `apps/frontend/AGENTS.md` — слои (app тонкая, features плоские, components папка=компонент, hooks/api/lib/i18n), Server/Client-граница, проверки `bun run lint` + `bun run build`.
- `apps/frontend/CODE_OF_CONDUCT.md` — §1 features-flat, §2 layout-owns-placement, §3 component-folders.
- `DESIGN.md` + `apps/frontend/DESIGN.md` — §3 реестр компонентов, §4 радиусы `var(--radius*)`, §4.1 без теней/трансформов, §5.1 `data-shell-variant=chat`, §7 плоский Content. DESIGN правит человек (корневой §6).

## 1. Целевая архитектура (стало)

```
app/organizations/[orgId]/projects/[projectId]/sessions/[sessionId]/
  layout.tsx   — НОВЫЙ, Server, без 'use client': grid rows [minmax(0,1fr)_auto], min-h, пин композера sticky bottom-2 z-20
  page.tsx     — тонкий Server: await params → <ChatSection sessionId projectId />

src/features/  (плоско, §1)
  chat-section.tsx       — состояние useChat + ?agent= синк + <ChatThread/> + <ChatInput/> (классы из layout) + диалоги
  chat-fork-dialog.tsx   — move из chat/
  chat-revert-dialog.tsx — move из chat/
  __tests__/chat-section-url.test.tsx — move из chat/__tests__/

src/components/chat/  (папка = компонент, §3: <Имя>.tsx + types.ts + index.ts)
  chat-thread/ChatThread.tsx + types.ts + index.ts   — виджет треда: MessageScrollerProvider/Viewport/Content + ветки + порядок Items
  chat-thinking-row/ChatThinkingRow.tsx + types.ts + index.ts
  chat-streaming-row/ChatStreamingRow.tsx + types.ts + index.ts
  chat-thread-empty/ChatThreadEmpty.tsx + types.ts + index.ts
  chat-thread-loading/ChatThreadLoading.tsx + types.ts + index.ts
  chat-tool-timeline/ChatToolTimeline.tsx + types.ts + index.ts  (rename из chat-tools-timeline)
  chat-live-status/ChatLiveStatus.tsx + types.ts + index.ts     (rename из agent-thinking/AgentThinking)
  chat-message/   — + types.ts (ChatMessageRowProps вынести)
  chat-input/     — + types.ts (ChatInputProps вынести)
  agent-selector/ — + types.ts (AgentSelectorProps вынести)
  __tests__/chat-thread.test.tsx — переехавший chat-window.test.tsx (ChatWindow→ChatThread)
  chat-window/ — УДАЛЕНА ЦЕЛИКОМ (chat-window.tsx прекращает существование, shim удалён)
```

## 2. Сетка и z-order (жёсткие требования)

- Владелец — только `sessions/[sessionId]/layout.tsx` (Server): `grid grid-rows-[minmax(0,1fr)_auto]`, тред-строка `min-h-[20rem] min-w-0`, композер-строка `sticky bottom-2 z-20 mx-auto w-[50%] bg-background` (замена текущего `absolute bottom-2 right-[calc((100%-300px)*0.25)]` — тот же визуал без viewport-magic).
- Тред: `MessageScroller` заполняет строку layout (`h-full min-h-[20rem]` через `className` от layout, своих `h-[calc(100dvh)]` НЕТ); `MessageScrollerContent pt-[calc(var(--header-height)_+_1rem)]` — underlap: сообщения стартуют ниже Header и уходят ЗА него; скролл внутри `Content overflow-y-auto`.
- z: Header `z-30` (шелл, не меняется) > PromptInput `z-20` (layout пин) > чат-панель `z-0` (`Content variant=chat [grid-area:1/2/-1/3]`, без border/bg).
- Блок сообщений ниже Header И PromptInput: `section grid gap-2` в фиче + `pb` резерв в layout-строке композера.

## 3. Пропсы/типы (только `export type` в `types.ts`, без `interface`)

- `chat-thread/types.ts`: `ChatThreadProps { messages: ChatMessage[]; streamingText: string; loading?; sending?; error?: string|null; onRetry?; toolTrace?: ChatToolEvent[]; activeAgentName?; activeToolName?; onFork?; onRevert?; className?: string }`.
- `chat-thinking-row`: `{ activeAgentName?; activeToolName? }`; `chat-streaming-row`: `{ streamingText: string; activeAgentName?; activeToolName? }`; `chat-live-status`: `{ activeAgentName?; activeToolName? }`; `chat-tool-timeline`: `{ events: ChatToolEvent[]; liveToolName?: string|null }`; empty/loading: `export type XProps = Record<string, never>`.
- `ChatMessageRowProps/ChatInputProps/AgentSelectorProps` — вынести без изменения шейпа. `ChatSectionProps { sessionId?; projectId?; className?; composerClassName? }` — в фиче.

## 4. Порядок шагов (8 атомарных коммитов)

1. Листья §3 — 6 новых папок + `types.ts` в 3 существующих. Проверка: §3-цикл молчит, `tsc` зелёный.
2. Виджет треда `chat-thread/` (перенос без `h-[calc]`, `pt` underlap оставить). Дубль `features/chat-thread.tsx` пока жив.
3. Фича flatten (`chat/` → 3 плоских файла + тест). Проверка: `find -mindepth 2` по chat пуст.
4. Layout (Server grid) + page (Server params). Убрать 'use client'/`useParams`.
5. Резка: удалить `features/chat-thread.tsx` + `chat-window/` целиком; обновить `components/chat/index.ts`. Проверка: `ls chat-window` → нет; `grep ChatWindow` → пусто.
6. Дотяжка фичи: убрать дефолтный absolute-пин, прокинуть `className`. Проверка: `grep h-[calc` и `grep absolute.*bottom` по features/components пусты.
7. Реестр (DESIGN §3.2: −ChatWindow +7; §3.3: +ChatSection/Fork/Revert; AGENTS-структура) — human approve; тесты (chat-window→chat-thread + className-кейс).
8. Контроли (см. §5).

НЕ делать: шелл/Content/css, `usage/`, rename MessageRow/AgentSelector, useChat/SSE/API/i18n.

## 5. Контроли (дословно, из корня репо)

```sh
find apps/frontend/src/features -mindepth 2 -print
# ожидаемо: только usage/* (долг вне скоупа)
for d in apps/frontend/src/components/chat/*/; do ls "$d" | grep -q '\.tsx$' && { test -f "$d/types.ts" || echo "NO types.ts: $d"; test -f "$d/index.ts" || echo "NO index.ts: $d"; }; done
grep -rln 'export type \w\+Props' apps/frontend/src/components --include='*.tsx' --include='!types.ts'
grep -rn "^'use client'" apps/frontend/app --include='layout.tsx'
grep -rn 'h-\[calc(100dvh' apps/frontend/src/features apps/frontend/src/components --include='*.tsx'
grep -rn 'absolute.*bottom-2\|right-\[calc' apps/frontend/src/features apps/frontend/src/components --include='*.tsx'
ls apps/frontend/src/components/chat/chat-window 2>&1
grep -rn 'ChatWindow' apps/frontend/src apps/frontend/app --include='*.tsx' --include='*.ts'
bun run lint
bun run build
```

Приёмка визуала (вручную): underlap под Header; PromptInput z-20 закреплён; скролл только в Content; empty/loading/error-C6 как раньше; thinking→streaming без прыжка; timeline не уводит auto-follow; fork/revert из рядов.

## 6. Риски

- R1 ширина 50% на узких экранах → проверить 768/1280/1920, ширину держать в layout.
- R2 rename `tools-timeline→tool-timeline` → `grep -r tools-timeline` после шага 1.
- R3 DESIGN правит человек → PR «реестр §3» отдельно.
- R4 `usage/` останется в `find -mindepth` → фильтровать `grep -v usage`, долг зафиксирован.
