# PLAN — CLI TUI страницы: sessions / login / chat / sessions-grid + todo (apps/cli)

Ветка: `feat/chat-commit-cur`. Корень: `/media/codebase/@web2bizz/devbox`.
Target state: в `apps/cli` 4 TUI-экрана на `@opentui/react` — sessions (пометка локально|облако), login (ссылка на страницу входа), chat (расширение ReplScreen), sessions-grid (сетка, управление каждой сессией) + todo list на странице сессии. TanStack Query только как data-layer поверх `backend.ts`. Локально, без Trello, в этом worktree/ветке. Только план — исполнение отдельно.
Подтверждено: вариант CLI+TUI.

## Complexity / риск сводно (из @evo-plan ses_e3f2892daffeicw4eehGl6Hilf)

- complexity: {score: 14, level: high, files: 13, cards: 6, deps: 5, type: add, unknowns: 4}
- risk: {level: medium, score: 5, factors: [external, breaking]}
- mitigation: backend-запросы только через `src/agents/opencode/backend.ts` + `chatLocal` и `RUSH_CODE_BACKEND_URL`-валидатор `src/core/backend.ts` с bounded probe; tanstack-query только как data-layer (QueryClient в `commands/runners.ts`, без React-императива), ленивый dynamic import экранов сохраняется; раннеры/интерактив менять аддитивно; fg-only/width=100%/без рамок/без raw ESC/ stdout только через `out()`; barrel-фасады + ~150 строк/модуль; проверка `bun test --isolate src`
- classify_build: `jev 1.0 (build-smart)` x6, `needs_tunnel: false`

## Карточки (строго последовательно)

### 1 — CLI sessions data-layer (local|cloud) поверх backend.ts

Файлы:
- `src/core/queries/sessions/types.ts` + `resolve.ts` + `client.ts` + `index.ts`-barrel
- `src/core/queries/index.ts` (реэкспорт)
- `src/agents/opencode/backend.ts` (только аддитивный list/get, cached session не ломать)

Чек-лист:
- [ ] Типы `SessionRef {id,title,origin:'local'|'cloud',updatedAt}`, pure-мапперы `originBadge/listSessionLines/gridCells` из backend-пейлоада
- [ ] Fetcher `listSessions/fetchSession` через `backendApiUrl+resolveBackendUrl` (`src/core/backend.ts`) и `chatLocal`-совместимый fetch (timeout/abort как в `backend.ts`)
- [ ] TanStack Query только как data-layer: QueryClient создаётся в `commands/runners.ts`, пробрасывается пропсом, хуки `useQuery` только внутри screens; прямых fetch в screens нет
- [ ] `RUSH_CODE_BACKEND_URL` отсутствует => понятная ошибка из `core/backend.ts`

Done: `bun test --isolate src` зелёный, pure-мапперы покрыты, нет прямых fetch в screens.

---

### 2 — CLI login-экран + раннер

Файлы:
- `src/ui/screens/login/LoginScreen.tsx` + `index.tsx`-barrel (+ константы/nav по образцу `screens/home/` при нужде)
- `src/ui/screens/index.ts` (реэкспорт)
- `src/commands/runners.ts` (`startTuiLogin` через withTuiHost + ленивый import)
- `src/commands/interactive.ts` (маршрут home → login при отсутствии backend/auth)

Чек-лист:
- [ ] Plain-экран без рамок, fg-only, ссылка на страницу входа как текст + статус (`checkBackendHealth`)
- [ ] Раннер ленивый (dynamic import `screens/index.js`), barrel-реэкспорт
- [ ] ESC только `String.fromCharCode(27)`, stdout только через `out()` после destroy

Done: source-контракт барреля + раннера зелёный, конвенции AGENTS.md соблюдены.

---

### 3 — CLI sessions-экран (список, пометка локально|облако)

Файлы:
- `src/ui/screens/sessions/SessionsScreen.tsx` + `nav.ts` + `index.tsx`-barrel
- `src/commands/runners.ts` (`startTuiSessions`)
- `src/commands/interactive.ts` (маршрут)

Чек-лист:
- [ ] Список сессий (›, стрелки/цифры, Enter — открыть, Esc/q — назад) по образцу `ProjectsScreen.tsx`, пометка `originBadge` локально|облако из карточки 1
- [ ] Данные через QueryClient-пропс, fallback — проп `sessions[]`; без fs внутри экрана
- [ ] fg-only, ленивый раннер, barrel-реэкспорт

Done: nav pure-функции + source-контракт зелёные, поведение как ProjectsScreen.

---

### 4 — CLI chat-экран (расширение ReplScreen) + runner

Файлы:
- `src/ui/screens/repl/ChatScreen.tsx` (обёртка над `ReplApp`: пропы `sessionId/origin/initialLines`, история через `LineStore`) + обновить `repl/index.tsx`
- `src/commands/runners.ts` (`startTuiChat({sessionId,greeting,onLine->chatLocal})` копией пути `startTuiRepl`)
- `src/commands/interactive.ts` (маршрут sessions → chat)

Чек-лист:
- [ ] Старый `startTuiRepl/ReplApp` не сломан (аддитивность)
- [ ] Chat идёт только через `backend.ts/chatLocal`, scrub/extract сохранены
- [ ] fg-only/plain chat (`USER_FG/AGENT_FG`), спин через `session.spin` → `<Spinner/>`

Done: `bun test --isolate src` зелёный, старый repl работает как раньше.

---

### 5 — CLI sessions-grid (сетка чатов, управление каждой сессией)

Файлы:
- `src/ui/screens/sessions-grid/SessionsGridScreen.tsx` + `nav.ts` (grid move 2D, цифры, Enter открыть, x/d закрыть/удалить, Esc/q назад) + `index.tsx`
- `src/commands/runners.ts` (`startTuiSessionsGrid`)
- `src/commands/interactive.ts` (sessions ⇄ grid переключатель)

Чек-лист:
- [ ] Сетка cells из карточки 1 (title + originBadge), каждая ячейка управляема
- [ ] 2D-навигация не выходит за границы, пустая сетка — plain-пустое состояние
- [ ] Мутации (close/delete) через data-layer QueryClient invalidate, без прямых императивных Box/Text в раннере
- [ ] fg-only/без рамок/без raw ESC, ленивый раннер + barrel

Done: grid-nav pure + source-контракт зелёные.

---

### 6 — CLI todo-list на странице сессии + финальные контракты

Файлы:
- `src/ui/screens/session-todo/` или `components/SessionTodo.tsx` (≤150 строк)
- Интеграция в `ChatScreen` (нижняя/боковая plain-панель, fg-only)
- Тесты: pure todo-редьюсер + source-контракты всех новых баррелей/раннеров

Чек-лист:
- [ ] Todo add/toggle/remove pure, хранение локально в LineStore-adjacent store (+ опционально backend при наличии API; по умолчанию локально, без ломки `backend.ts`)
- [ ] Все 4 экрана доступны через screens-barrel + runners (`startTuiLogin/Sessions/Chat/Grid`)
- [ ] Grep-проверки AGENTS.md: `no backgroundColor/bg:/fill/Rect`, `no console.*`, `out()` единственный writer, `String.fromCharCode(27)`

Done: todo-редьюсер покрыт, `bun test --isolate src` зелёный, конвенции проходят grep.

## Порядок и зависимости

1 → 2 → 3 → 4 → 5 → 6, строго последовательно. 3 ждёт 1 (originBadge/data-layer), 4 ждёт 1+3 (sessions → chat), 5 ждёт 1+3 (cells + переключатель), 6 ждёт 4 (интеграция в ChatScreen).

## Что НЕ делать (non-negotiable)

- Не вводить новую external-зависимость без нужды (если `@tanstack/*` нет в `package.json` — лёгкий QueryClient-shaped кэш той же формы вместо новой зависимости, либо ставить только с явного approve и проверкой после каждой карточки).
- Не ломать `cached session` в `backend.ts`, `startTuiRepl/ReplApp`, маршрут home→chat; только аддитивно.
- Не тащить fs/fetch/console/raw ESC/императивные Box/Text в screens; stdout только через `out()`.
- Не работать через Trello; только локально в `feat/chat-commit-cur`, Forward-Only (`git rev-list --count baseCommit..HEAD >= 0`, `reset --hard`/`push --force` запрещены).
