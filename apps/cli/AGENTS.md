# apps/cli — AGENTS.md

Конвенции CLI (по факту `src/` на 2026-10-24). Проверяемо grep/`bun test`.

## Дерево `src/`

- `src/cli.ts` — entry: arg-парсинг (`--help/--version/agent list|run/resolve/repl`), TTY-гейт, `main()` на импорте. Entry — `cli.ts` по спеке (`bun src/cli.ts` + shebang + тесты не ломаем).
- `src/commands/` — интерактив и команды за entry:
  - `src/commands/commands.ts` — `/agent`, `resolve`, `dispatchLine` (pure dispatch, без readline).
  - `src/commands/interactive.ts` — TUI-only интерактив (home → проект/директория → chat); единственные stdout-записи — финальные `statusLine` после destroy renderer.
  - `src/commands/sinks.ts` — `out()` + `stdoutSink`/`tuiSink`/`LineSink` (spin/header/box/error/table).
  - `src/commands/runners.ts` — OpenTUI-раннеры `startTuiRepl/startTuiHome/startTuiProjects/startTuiDirInput/startTuiError` (ленивый dynamic import `../ui/screens/index.js`, bootstrap renderer, `session.spin` делегирует `<Spinner/>`, `createLineStore` — статический импорт из `../ui/shared/store.js`).
  - `src/commands/session.ts` — типы `TuiSession/TuiLineResult`, `TUI_HISTORY_CAP=400`, `TUI_TARGET_FPS=30`, `tuiStartupOrder`.
  - `src/commands/index.ts` — баррель (`commands` + `interactive` + `sinks`).
- `src/ui/` — весь рендер:
  - `src/ui/shared/` — общие презентационные примитивы:
    - `chat.ts` — full-width plain chat (`formatUserMessage/Agent`, `…Plain`, `USER_FG=cyan/AGENT_FG=green`, `wrapMessage`, `terminalWidth/resolveTerminalWidth`).
    - `plain.ts` — plain-текст без рамок (`headerText/errorText/tableText/greetingLines/statusLine`).
    - `store.ts` — `LineStore`/`createLineStore(cap)`: история + subscribe, `kind`-типизация строк.
    - `index.ts` — баррель (3 реэкспорта).
  - `src/ui/components/` — презентационные компоненты:
    - `Spinner.tsx` — сам-анимированный `<text width="100%">` (свой `setInterval` 80мс, fg-only, без border; фреймы из `core/utils/frames.js`).
    - `index.ts` — баррель.
  - `src/ui/screens/` — декларативные OpenTUI-деревья + баррель `index.ts`:
    - `home/` — home-модуль (RUSH CODE Главная): `HomeScreen.tsx` (`HomeApp`: арт статичен, `selected` двигает маркер `›`, цифрвыбор 1-3) + `constants.ts` (только константы: `HOME_TITLE_ART/OPTIONS/SIGNATURE/STOPS`, `HomeOptionIndex`, ESC-стрелки) + `gradient.ts` (лого-градиент, fg-only truecolor; stdout ANSI 38;2 + TUI hex-чанки) + `layout.ts` (геометрия: `centerLines/homeArtBlock/option rows`, `titleTextOptions`) + `screen.ts` (stdout home-рендеры, pure, без I/O) + `nav.ts` (клавиатурная навигация: `moveHomeSelection`, парсинг `1-3`/стрелок) + `index.tsx` (баррель всего модуля).
    - `projects/` — `ProjectsScreen.tsx` (пикер проекта: `›`, стрелки/цифры, Esc/q → null, без fs) + `DirInputScreen.tsx` (ввод директории: один focused `input`, `REPOS_ROOT`-хинт, без fs) + `index.tsx` (баррель).
    - `repl/` — `ReplScreen.tsx` (`ReplApp`: `kind → <box>/<text>`, sticky-bottom history + prompt `input`) + `index.tsx` (баррель).
    - `error/` — `ErrorScreen.tsx` (ошибка: plain red, `onClose` + `useKeyboard`, без border) + `index.tsx` (баррель).
    - `index.ts` — баррель (4 реэкспорта на `*/index.js`, замена удалённого `tui-app.tsx`).
  (`src/ui/home/` и `src/ui/tui/` удалены: home-модуль живёт в `screens/home/`, раннеры/сессия — в `commands/runners.ts` + `commands/session.ts`; в `ui/` ровно три зоны: `shared/`, `components/`, `screens/`.)
- `src/core/` — фреймворк-независимое ядро:
  - `src/core/utils/` — чистые хелперы:
    - `frames.ts` — pure ASCII-фреймы (`SPINNER_FRAMES/spinnerFrame/spinnerLine`, без таймеров/I/O).
    - `paste.ts` — `TUI_INPUT_MAX_LENGTH=10000` + `normalizePastedText` (без I/O/React).
    - `index.ts` — баррель (2 реэкспорта).
  - `src/core/queries/` — запросы:
    - `src/core/queries/refs/` — `@ref` внутри `REPOS_ROOT` (fail-fast, `..` denied, jail prefix-check, scrub превью):
      - `resolve.ts`, `projects.ts` (`listProjects/resolveProjectDir/resolveCustomDir`, только чтение), `__tests__/projects.test.ts`, `index.ts` — баррель.
    - `src/core/queries/index.ts` — баррель (`refs`).
  - `src/core/index.ts` — баррель (`utils` + `queries`).
- `src/agents/`:
  - `src/agents/allowlist.ts` — статичный allowlist (ask/plan/build/build-fast/build-smart/refactor/unit-test/review/diagnostics/task-manager/devops).
  - `src/agents/runner.ts` — dry-run по умолчанию (`--apply` лишь подтверждает намерение, мутаций нет).
  - `src/agents/opencode/index.ts` — фасад → siblings + `chatLocal` (cloud-first композиция; замена `agents/opencode.ts`).
  - `src/agents/index.ts` — баррель (`allowlist` + `runner` + `opencode/index`).
- `src/agents/opencode/` — cloud-first чат:
  - `constants.ts` — таймауты/URL/SDK-пин (`OPENCODE_CLOUD_URL`, `OPENCODE_CLOUD_MODEL=deepseek-v4.1-flash`, `OPENCODE_SDK_VERSION=1.18.33`).
  - `config.ts` — env-резолверы cloud/serve (без секретов/I/O).
  - `auth.ts` — ключ только из `auth.json` (диагностика без значения: `key_len/perms/uid`).
  - `text.ts` — scrub + extract payload + маппинг ошибок (без fetch).
  - `cloud.ts` — прямой cloud-чат (без serve/localhost).
  - `serve.ts` — OPTIONAL fallback только при `OPENCODE_USE_SERVE=1`.
- `src/prompt/repl.ts` — парсер строк (`parseLine`), `CLEAR_SEQUENCE=ESC+c`, TTY-гейты, `helpText` (без readline).
- `src/ui/__tests__/` — `ascii.test.ts` (plain-снапшот, 10 спиннер-фреймов), `chat.test.ts`, `home.test.ts`, `tui.test.ts` (source-контракты).
- `src/agents/__tests__/opencode-key.test.ts` — ключ/клиент (missing-key fail-fast, scrub, `/agent`-парсинг).
- `src/core/queries/refs/__tests__/projects.test.ts` — jail-проекты.
- Заглушки `// moved to …` (удалить через `git rm`, код уже живёт по новым путям): `src/cli/{commands,interactive,sinks}.ts`, `src/refs/{resolve,projects}.ts` + `src/refs/__tests__/projects.test.ts`, `src/agents/opencode.ts`, `src/ui/{chat,plain,store,tui,home,spinner}.ts`, `src/ui/tui/paste.ts`, `src/ui/tui-app.tsx`, `src/ui/home/*.ts` (→ `src/ui/screens/home/*`), `src/ui/tui/{index,runners,session}.ts` (→ `src/commands/*`). Каталоги `src/ui/spinner/` (старые `frames.ts`/`Spinner.tsx`) и `src/cli/`, `src/refs/`, `src/ui/home/`, `src/ui/tui/` удаляет человек целиком.

## Правила

- Фасад + каталог: `opencode/index.ts→opencode/`, `commands/index.ts→commands/`, `shared/index.ts`, `components/index.ts`, `screens/index.ts`, `screens/home/index.tsx`, `core/utils/index.ts`, `core/queries/index.ts`, `core/index.ts`, `agents/index.ts` (+ `commands/runners.ts` + `commands/session.ts` — раннеры/сессия без фасада). Канон — в подкаталоге, фасад только реэкспортит (+ `chatLocal` в `opencode/index.ts`, маршрутизация в `cli.ts`). Entry — `cli.ts` по спеке.
- Один модуль — одна ответственность, целевой лимит ~150 строк. Известные исключения: `commands/runners.ts` (~215), `agents/opencode/text.ts` (~217).
- React-рендер только через `@opentui/react` (`createRoot` + `.render()` в `commands/runners.ts`, деревья в `screens/*`). `@opentui/core` — только `createCliRenderer`-bootstrap через `dynamic import()` (ленивость: `--help`/non-TTY/CI не трогают нативные биндинги и reconciler). Императивных `new BoxRenderable/TextRenderable/ScrollBox/InputRenderable`, `keyInput`, `renderer.root` в TUI-пути нет.
- Прозрачность fg-only: запрет `backgroundColor/setBackgroundColor`, `background`, `fill`, `Rect`, `bg:` (см. `expectTransparent` в `tui.test.ts`). Строки — `fg` + `width="100%"`, без border.
- Plain-вывод без рамок (`shared/plain.ts`: title как есть, ошибки `✗/→`, таблицы паддингом). ASCII-арт `┌┐└┘│═║╔╗╚╝` — только в тестах-негативах (`not.toContain`).
- stdout — только one-shot/`--help`/non-TTY/exit-логи (`statusLine` после destroy). Интерактив всегда TUI (`startTuiHome/Projects/DirInput/Error/Repl`, `interactive.ts` без `node:readline`).
- `process.stdout.write` только через `out()` из `commands/sinks.ts`. `console.*` запрещён в проде (тесты: `clearScreen` пишет через writer, `console.clear` не вызывается).
- No raw ESC в исходниках: ESC только через `String.fromCharCode(27)` (`repl.ts`, `core/utils/paste.ts`, `shared/chat.ts`, `screens/home/*`).
- Тесты — source-контракты + pure-функции: `bun test --isolate src`. Pre-existing красные в `opencode-key.test.ts` (3 шт) — не чинить молча.
- TypeScript `strict` (`tsconfig.json`), `import type` для типов, `.js`-суффиксы в относительных импортах.
