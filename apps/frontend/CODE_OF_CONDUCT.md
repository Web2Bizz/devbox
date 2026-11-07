# CODE_OF_CONDUCT — frontend

Канон слоёв: [`AGENTS.md`](./AGENTS.md).

## 1. features-flat

### Scope

`apps/frontend/src/features/` — все фичи веб-шелла.

### Rule

Фичи располагаются **плоско**: один файл на фичу/срез (`chat-section.tsx`,
`chat-thread.tsx`, `chat-fork-dialog.tsx`), без вложенных каталогов
(`features/chat/`, `features/chat/thread/` запрещены).

- Композиция + порядок строк живут в файле фичи; геометрию маршрута
  (`grid`/высоты/пины) задаёт `app/**/layout.tsx` (см. §2) — фича её
  получает через `className` и сама не задаёт.
- Страница `app/` только владеет `<ФичаСекция />`, бизнес-логика — в
  `features/` + `hooks/` (см. AGENTS.md «Слои»).
- Глупые строки/примитивы — в `src/components/` (только пропсы → вёрстка,
  без `useChat`/ветвлений).

```text
// do
src/features/chat-section.tsx
src/features/chat-thread.tsx

// don't
src/features/chat/chat-section.tsx
src/features/chat/thread/ChatThread.tsx
```

### Control

```sh
# должен ничего не напечатать — нет вложенных каталогов в features/
find apps/frontend/src/features -mindepth 2 -print
```

## 2. layout-owns-placement

### Scope

`apps/frontend/app/**/layout.tsx` (владелец) + `apps/frontend/src/features/*`
+ `apps/frontend/src/components/**/*` (потребители).

### Rule

Расположением блоков владеет **только `layout.tsx`** (Server по умолчанию,
без `'use client'`, без `useState`/`useEffect`/`usePathname`): `grid`,
высоты (`h-[calc(100dvh_…)]`), отступы под Header
(`pt-[calc(var(--header-height)_…)]`), пины (`absolute`/`fixed` композера),
слоты (`children`, параллельные `@slot`).

- Фича (`src/features/*.tsx`) — состояние + порядок строк; геометрию
  получает через `className` от layout и сама `h-[100dvh]`/`absolute`-пин
  не задаёт.
- Компоненты (`src/components/`) — только свой ряд (`gap-1`, `py-2`);
  общий `grid` задаёт layout сверху.

```text
// do — layout владеет grid, фича порядком, компонент рядом
app/.../sessions/[sessionId]/layout.tsx  // grid + heights + composer pin
src/features/chat-thread.tsx            // ветки + порядок строк
src/components/chat/chat-thinking-row.tsx // один ряд

// don't
src/components/chat/chat-window.tsx     // grid + высоты + ветки в компонентах
src/features/chat-thread.tsx            // absolute bottom-2 w-[50%] в фиче
app/.../layout.tsx                      // 'use client' + useState в layout
```

### Control

```sh
# должен ничего не напечатать — 'use client' и хуки в layout запрещены
rg -l "use client" apps/frontend/app --glob 'layout.tsx'
rg -l "use(State|Effect|Pathname)" apps/frontend/app --glob 'layout.tsx'

# высоты маршрута — только в app/**/layout.tsx и шелле, не в фичах/компонентах
rg -l 'h-\[calc\(100dvh' apps/frontend/src/features apps/frontend/src/components
```
