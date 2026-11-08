# Epoch 3: Decision foundation

## Hypothesis
Разложение обязано удовлетворить одновременно: §1 (плоские фичи), §2 (геометрия только в layout), §3 (папка=компонент + types.ts), DESIGN §3 (реестр), §5.1 + жёсткие требования сетки (z-order, underlap).

## Evidence Found
- §2 do-образец прямо называет целевую тройку: `app/.../sessions/[sessionId]/layout.tsx // grid + heights + composer pin` + `src/features/chat-thread.tsx // ветки + порядок строк` + `chat-thinking-row // один ряд`. И dont-образец: `chat-window.tsx // grid+высоты+ветки в компонентах`, `chat-thread.tsx // absolute пин в фиче`, `layout // 'use client'` — все три dont-практики СЕЙЧАС в коде (пин в chat-section, высоты в chat-thread/components, page 'use client' вместо layout).
- AGENTS.md «Структура» уже канонизирует будущее: `components/chat/` папки `chat-thread/ chat-row/ chat-tool-timeline/ chat-input/ chat-message/ model-selector/` (плоских `chat-*.tsx` нет) + `features/` плоско `chat-section.tsx, chat-thread.tsx, usage-section.tsx`. Текущий код отстаёт: нет `chat-thread/`, есть `chat-window/` + `agent-selector/` вместо `model-selector/` (переименован в AgentSelector по факту).
- `grep "use client" app --include=layout.tsx` даёт ложное срабатывание на `(dashboard)/layout.tsx` (комментарий `client-only Kit blocks`, не директива). Точный контроль: `grep -rn "^'use client'" app --include='layout.tsx'` должен быть пуст.

## Decisions
- Decision D1: Скроллер-треда = компонент-виджет `src/components/chat/chat-thread/` (MessageScrollerProvider/Viewport/Content + ветки loading/error/empty + порядок Items), фича = тонкая `src/features/chat-section.tsx` (useChat + AgentSelector-синк + `<ChatThread/>` + `<ChatInput/>` в слоте от layout + диалоги). Rationale: требование пользователя «виджет треда (скроллер)» + «фичу (плоский файл)» = две сущности; §2 оставляет фиче «состояние+порядок», но высоты/пины — только layout; компонентный скроллер переиспользуем и тестируем изолированно. Alternatives: оставить `features/chat-thread.tsx` как есть — rejected (в нём `h-[calc(100dvh...)]`, нарушение §2, контроль не сойдётся).
- Decision D2: `chat-window.tsx` удаляется физически + shim в `chat-window/index.ts` удаляется, затем вся папка `chat-window/` удаляется. Rationale: требование «chat-window.tsx должен прекратить существование»; дубль с ChatThread уже разведён через shim — пора резать. Alternatives: оставить shim — rejected (россыпь сохраняется).
- Decision D3: Ряды — по одной папке на компонент (§3): `chat-message/` (существует, добавить types.ts), `chat-thinking-row/`, `chat-streaming-row/`, `chat-thread-loading/`, `chat-thread-empty/`, `chat-tool-timeline/` (переименовать из `chat-tools-timeline` к единому `chat-*` + папка). Live-статус — отдельная папка `chat-live-status/` (переименованный `agent-thinking.tsx` → `ChatLiveStatus`, `AgentThinkingProps` → `ChatLiveStatusProps`), потребляется обоими live-рядами. Rationale: требование «компоненты рядов (по §3), виджет статуса live». Alternatives: оставить `agent-thinking` имя — rejected (реестр DESIGN знает `Chat*`, `Agent*` только селектор; live-статус должен читаться как чат-виджет).
- Decision D4: Геометрия целиком в НОВЫЙ `app/.../sessions/[sessionId]/layout.tsx` (Server, без 'use client'): grid `rows [1fr_auto]` (тред + композер), высоты `h-[calc(100dvh_-_9rem)]`-класса → заменить на `minmax(0,1fr)` + `min-h-[20rem]` внутри layout-слотов, `pt-[calc(var(--header-height)_+_1rem)]` на контейнере треда, пин композера (`absolute/sticky bottom + z-20`) в layout, Header остаётся `z-30` из шелла. Фича/компоненты получают `className` и своих `h-[100dvh]/absolute` не задают. Rationale: §2 + жёсткие требования (PromptInput z выше чата; сообщения ниже Header+PromptInput; underlap).
- Decision D5: `page.tsx` сегмента → тонкий Server (async params → `<ChatSection/>`), убрать 'use client'/`useParams`. Rationale: §2 Server-граница; интерактив — в фиче.
- Decision D6: `src/features/chat/*` уплощается в `src/features/chat-section.tsx` + `chat-fork-dialog.tsx` + `chat-revert-dialog.tsx` (удалить каталог + `__tests__/chat-section-url.test.tsx` перенести рядом `chat-section-url.test.tsx` или в `__tests__/` корня features — решить в Epoch 5). `usage/` не трогаем (вне скоупа, зафиксировать как известный долг). Rationale: §1 контроль `find -mindepth 2` должен молчать по `chat` (usage останется — отметить в PLAN как out-of-scope).

## Confirmed Plan Items
1. Целевое разделение layout/page/фича/тред/ряды/live-статус — решение D1–D6, артефакты и rationale выше.
2. Удаление chat-window.tsx + папки — решение D2.

## Open Questions
- Точные пропсы/types.ts каждого нового компонента? Точный grid-класс layout (absolute vs sticky пин композера, `right-[calc...]` сохранить?)? Порядок шагов и реестр DESIGN §3 (удалить ChatWindow, добавить новые)? Тесты (`__tests__/chat-window.test.tsx` → куда)?

## Next Epoch Focus
- Epoch 4: было→стало по каждому файлу + пропсы/типы + сетка/z в классах.
