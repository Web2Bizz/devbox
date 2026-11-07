# Epoch 2: Evidence gathering + decision foundation

## Hypothesis
- `lucide-react ^0.577.0` (devDep кита `@web2bizz/ui 0.26.3`) содержит `History` и `GitFork` — обе иконки существуют в lucide годами, в 0.577 точно есть. Fallback понадобится только при ошибке сборки.
- `CopyButton` кита проксирует `ButtonProps` (`CopyButtonProps = Omit<ButtonProps,'children'> & {...}` из `widgets.d.ts`) и склеивает `className` через `cn` — значит `hover:bg-transparent` в `className` перебьёт kit-`hover:bg-accent`, как уже делает `FEEDBACK_TOGGLE_CLASS`.

## Evidence Found
- File: `node_modules/@web2bizz/ui/package.json` — `"lucide-react": "^0.577.0"` в devDependencies; в root `node_modules/lucide-react` нет (не hoisted) — прямого импорта из фронта сегодня нет.
- File: `apps/frontend/package.json` — подтверждено: `lucide-react` отсутствует в deps/devDeps.
- File: `node_modules/@web2bizz/ui/dist/widgets.d.ts` — `CopyButtonProps = Omit<ButtonProps, 'children'> & {content, copied, ...}` → `className`/`variant`/`size` пробрасываются в китовый `Button`.
- File: `chat-message.tsx:51,137-139,168-169` — прецедент `hover:bg-transparent` уже в файле и работает для `ToggleGroupItem`; тот же механизм (`cn`+tailwind-merge, `className` last wins).
- Pattern: DESIGN — kit tokens only, no hex; variant кита не менять (ghost).

## Decisions
- Decision: revert → Lucide `History` (семантика «откат к снапшоту», не `Undo2` — undo = отмена последнего действия, history = возврат к точке).
  - Alternatives considered: `Undo2` — rejected: неверная семантика для revert-to-snapshot.
  - Rationale: чтение задачи + смысл действия.
- Decision: fork → Lucide `GitFork` (семантика «ветвление»).
  - Alternatives considered: `Split` / `GitBranch` — fallback только если `GitFork` отсутствует в установленной версии lucide-react (проверяется на шаге сборки; все три — долгоживущие иконки, отсутствие маловероятно).
  - Rationale: прямое соответствие fork = ветвление.
- Decision: `lucide-react` добавить прямой зависимостью во фронтенд `^0.577.0` (align с китом), а не полагаться на транзитив.
  - Alternatives considered: транзитивный импорт из кита — rejected: хрупко, нет гарантии резолва/версий, нарушение границы слоёв.
  - Rationale: воспроизводимая сборка, одна версия иконок с китом.
- Decision: copy — `className="text-muted-foreground hover:bg-transparent"` (+ `focus-visible:bg-transparent` только если ручная проверка покажет остаточный фон при keyboard-focus); `variant="ghost"` не менять.
  - Alternatives considered: смена variant / кастомный Button вместо CopyButton — rejected: нарушает «variant кита не менять».
  - Rationale: минимальный дифф, опора на существующий прецедент в том же файле.

## Confirmed Plan Items
1. Добавить `lucide-react ^0.577.0` в `apps/frontend/package.json` (deps) + `bun install` — reason: прямой импорт иконок, artifact: `package.json`/`bun.lock`, validation: импорт резолвится.
2. В `chat-message.tsx`: импортировать `{ History, GitFork }` из `lucide-react`; тело fork/revert-кнопок заменить текст на `<History size={16} aria-hidden />` / `<GitFork size={16} aria-hidden />`, сохранив `Button variant="ghost" size="sm"`, все `aria-label`/`title`/`data-testid`/`onClick` — reason: иконки вместо текста, artifact: `chat-message.tsx:1-13,207-234`, validation: визуально иконки, a11y-атрибуты на месте.
3. В `chat-message.tsx:197-206`: `CopyButton className` → `"text-muted-foreground hover:bg-transparent"` — reason: убрать hover-фон, artifact: та же строка, validation: hover без фона.
4. `bun run lint` в `apps/frontend` (tsc --noEmit + biome) чист — reason: критерий приёмки, artifact: —, validation: exit 0.

## Open Questions
- Нет открытых вопросов — все разрешения получены («Да, делай», low/low, 1 карточка).

## Next Epoch Focus
- Валидация при реализации: если `GitFork` не экспортируется установленной версией — fallback `GitBranch`, затем `Split`; если `focus-visible` даёт фон — добавить `focus-visible:bg-transparent`. Это runtime-ветвления внутри шагов 2–3, отдельной эпохи не требуют (depth=low, план финализируется).
