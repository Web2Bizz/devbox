# Epoch 5: Validation — каноны, реестр, тесты

## Hypothesis
D1–D9 закрывают все три параграфа CODE_OF_CONDUCT + DESIGN, если выдержать типы/реестр/тесты.

## Evidence Found
- DESIGN §3.2 знает `ChatWindow, ChatInput, ChatMessageRow` (+ `RunningSessionRow` и др.); §3.3 знает только `ApiKeyDialog, UsageSection` (ChatSection НЕ зарегистрирован — gap). AGENTS «Структура» уже обещает `chat-thread/ chat-row/ chat-tool-timeline/ chat-input/ chat-message/ model-selector/` — фактические имена расходятся (`ChatMessageRow` vs `chat-row`, `AgentSelector` vs `model-selector`, `ChatToolTimeline` vs `chat-tool-timeline`).
- Тест `src/components/chat/__tests__/chat-window.test.tsx` импортит `{ ChatWindow } from '../chat-window'` + `{ ChatInput } from '../chat-input'` — после удаления сломается; остальные тесты: `features/chat/__tests__/chat-section-url.test.tsx` (URL-синк), guard `no-opencode-transport`.
- Контроли канонов (точные команды):
  ```sh
  find apps/frontend/src/features -mindepth 2 -print   # §1: должен молчать по chat (usage — известный долг)
  for d in apps/frontend/src/components/chat/*/; do ls "$d" | grep -q '\.tsx$' && { test -f "$d/types.ts" || echo "NO types.ts: $d"; test -f "$d/index.ts" || echo "NO index.ts: $d"; }; done  # §3
  grep -rl "^'use client'" apps/frontend/app --include='layout.tsx'  # §2: пусто (остерегаться комментария client-only)
  grep -rn 'h-\[calc(100dvh' apps/frontend/src/features apps/frontend/src/components --include='*.tsx'  # §2: пусто
  grep -rn 'absolute.*bottom-2\|right-\[calc' apps/frontend/src/features apps/frontend/src/components --include='*.tsx'  # пин только в layout
  grep -rln 'export type \w+Props' apps/frontend/src/components --include='*.tsx'  # вне types.ts: пусто
  ```

## Decisions
- Decision D10 (реестр DESIGN §3.2, правит человек approve — DESIGN.md владелец-человек по корневому DESIGN §6): удалить `ChatWindow`; добавить `ChatThread, ChatThinkingRow, ChatStreamingRow, ChatThreadEmpty, ChatThreadLoading, ChatToolTimeline, ChatLiveStatus` (оставить `ChatInput, ChatMessageRow`); §3.3 добавить `ChatSection, ChatForkDialog, ChatRevertDialog` (сейчас отсутствует). AGENTS-блок «Структура» привести к факту: `chat-thread/ chat-thinking-row/ chat-streaming-row/ chat-thread-empty/ chat-thread-loading/ chat-tool-timeline/ chat-live-status/ chat-input/ chat-message/ agent-selector/`. Rationale: guard сверяет объявления с реестром — без правки посыпятся unregistered-component. Alternatives: не трогать DESIGN — rejected (guard упадёт).
- Decision D11 (тесты): `__tests__/chat-window.test.tsx` → `components/chat/chat-thread/__tests__/chat-thread.test.tsx` (или `chat-thread.test.tsx` рядом), заменить `ChatWindow`→`ChatThread`, `ChatWindowProps`→`ChatThreadProps`, сохранить все кейсы (empty/loading/error-C6/thread/roles/scroller-height/streaming/thinking/timeline/send) + добавить кейс `className` от layout (проброс без собственной геометрии). `chat-section-url.test.tsx` — перенести в `features/__tests__/` с обновлением импорта `@/features/chat-section`. Rationale: покрытие underlap/C6/z не теряем.
- Decision D12 (совместимость): `components/chat/index.ts` — удалить `export * from './chat-window'`, добавить 7 новых бареллей; алиас `export { ChatThread as ChatWindow }` НЕ сохранять (требование — прекратить существование). Внешние импорты (`chat-section.tsx`, тесты) — только на новые пути. `ChatMessageRow` имя сохранить (реестр + тесты), НЕ переименовывать в `ChatRow` (AGENTS-пример `chat-row/` — устарел, правит реестр, не код).

## Confirmed Plan Items
1. Реестр DESIGN §3 + AGENTS-структура — решение D10, валидация: guard unregistered-component молчит.
2. Миграция тестов без потери кейсов — решение D11.
3. Барелли без ChatWindow — решение D12.

## Open Questions
- Точный порядок шагов (атомарные коммиты, что за чем)? Команды lint/build и порог готовности?

## Next Epoch Focus
- Epoch 6: пошаговая последовательность + команды + критерии готовности.
