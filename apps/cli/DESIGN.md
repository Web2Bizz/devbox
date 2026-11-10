# apps/cli — DESIGN

CLI TUI (`@opentui/react@0.6.8`, `@opentui/core@0.6.8`). Приоритет правил:
корневой `DESIGN.md` §0 — рефера; при расхождении правит этот файл
(он ближе к коду и кит-версии).

## 1. Разрешённый декор (исчерпывающе)

- Обводка prompt-ввода: `<box border borderStyle>` вокруг `<input>`
  в `screens/repl/ReplScreen.tsx`. Значения по типам кита
  (`BoxRenderable`, `docs/components/box`): `single | double | rounded | heavy`,
  дефолт `rounded`. Тип `ReplBorderStyle`, опциональный проп
  `ReplAppProps.borderStyle` (обратная совместимость `startTuiRepl`).
- Row-sidebar чата: `screens/chat/ChatScreen.tsx` — `flexDirection="row"`,
  left `width="30%"` (`SessionsSidebar`) + right `width="70%"`
  (`ReplApp` сверху + `SessionTodoPanel` снизу).

Всё остальное — plain: `<text width="100%">` / `<box>` без рамок,
история/списки/ошибки/спиннер без ASCII-арта.

## 2. Палитра fg-only

- Только `fg` (+ `width="100%"`); фон терминала просвечивает.
- Запрет: `backgroundColor/setBackgroundColor`, `background`, `fill`,
  `Rect`, `bg:` (гейт `expectTransparent` в `src/ui/__tests__/tui.test.ts`).
- `borderColor` у input-обводки — дефолт кита, явно не задаём.

## 3. ESC и plain

- No raw ESC в исходниках: только `String.fromCharCode(27)`
  (`prompt/repl.ts`, `core/utils/paste.ts`, `shared/chat.ts`, `screens/home/*`).
- Сайдбар — неинтерактивный список через
  `listSessionLines` из `core/queries/sessions` (маркер `›`);
  пусто → плейсхолдер, без `useKeyboard`.
