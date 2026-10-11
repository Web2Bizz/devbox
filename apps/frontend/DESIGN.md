# DevBox Frontend — DESIGN

Дизайн-договорённости `apps/frontend` (Next 16.3 Turbopack + `@web2bizz/ui`
0.26.0). Подробности у кита: `node_modules/@web2bizz/ui/AGENTS.md`,
`docs/agents/anti-patterns.md`.

## 1. Порядок стилей

`app/layout.tsx` импортирует строго в этом порядке:

1. `@web2bizz/ui/styles.css` — токены, шрифты, базовый reset кита;
2. `./globals.css` — семантические переопределения приложения.

`globals.css` грузится ПОЗЖЕ, поэтому его `:root` / `.dark` выигрывают
у дефолтов кита при равной специфичности (source order). Порядок менять
нельзя: бренд-токены (`--accent` → `--brand-1`) зависят от него.

## 2. Токены

### Радиусы (кит: `dist/library/styles/radius.css` + `tailwind-theme.css`)

| Токен         | Значение              | Источник |
| ------------- | --------------------- | -------- |
| `--radius`    | `0.75rem`             | kit      |
| `--radius-lg` | `var(--radius)`       | kit      |
| `--radius-xl` | `var(--radius)`       | kit      |
| `--radius-md` | `calc(var(--radius) - 2px)` | kit |

Header кита (`shape=rounded`, default `sharp`!) несёт `sm:rounded-xl` на самом `<header>`
→ его радиус = `--radius-xl` = `--radius`. Позиционирование — наше
(sticky-pin в `globals.css` `.app-shell > .app-header`: `position: sticky`,
`top: var(--header-sticky-top)`, `z-index: 30`): кит 0.25.9 убрал
`variant=fixed|sticky` + `wide` + `headerWrapperClassNames`/`headerSpacerClassName`
(чистый бар без обёртки, `wide` больше нет — ширина задаётся шеллом).

### Геометрия Header (кит: `layout.css`)

| Токен                | Значение            |
| -------------------- | ------------------- |
| `--header-height`    | `70px`              |
| `--header-sticky-top`| `0px` → `0.5rem` от `sm` |

### Бренд (единственное место с hex — `:root` / `.dark` в `globals.css`)

Лого-палитра `#FF2A7A → #FF5E62 → #FF9966` живёт только в
`--brand-1/2/3`. Всё остальное ссылается семантически:
`--accent: var(--brand-1)`, `--gradient-brand`, `--filter-logo-glow`,
утилиты `.text-gradient-brand` / `.logo-glow` / `.shadow-brand-glow`.

## 3. Правило радиусов

**Sidebar + Content = Header.** `.app-sidebar` и `.app-content` используют
`border-radius: var(--radius-lg)` — визуально тот же радиус, что у бара
Header. Только `var()`-ссылки; hex — только в `:root` / `.dark`.

**Вложенность уменьшает радиус.** Каждый уровень вложенности внутри
`.app-content` / `.app-sidebar` / `Card` должен использовать меньший радиус,
чем родитель — чтобы вложенный блок визуально «вписывался» в скругление
родителя и не выглядел грубее:

| Уровень | Контейнер | Радиус |
| ------- | --------- | ------ |
| 0 — шелл | Header bar, `.app-sidebar`, `.app-content` | `var(--radius-lg)` (`--radius` = 0.75rem) |
| 1 — карточка/блок внутри Content | `Card`, `.status-grid > *`, секции | `var(--radius-md)` (`calc(var(--radius) - 2px)`) |
| 2 — вложенный элемент внутри Card | `Badge`, `Button`, инпуты, вложенный `Card`/панель | `var(--radius-sm)` (`calc(var(--radius) - 4px)`) или `var(--radius-xs)` |
| 3+ — глубокая вложенность | чипы, мелкие контролы | `var(--radius-xs)` / `calc(var(--radius) - 6px)` |

Правило: `radius(child) < radius(parent)`. Не использовать `var(--radius-lg)`/`var(--radius-xl)` внутри уже скруглённого контейнера того же радиуса.

Запрещено: `radius: 0` / flatten-селекторы поверх кита
(см. историю: `.app-shell > div:has(> .app-header)` с
`position: static; max-width: 100%; margin: 0` и `.app-header` с
`border-radius: 0` — удалены, не возвращать).

## 3.1 Запреты декора

- **Градиенты в блоках запрещены.** `linear-gradient`/`radial-gradient`/`conic-gradient` не использовать для `background` блоков, карточек, панелей, секций. Единственное исключение — **кнопки** (`Button variant="primaryBrand"` и аналогичные бренд-кнопки) — им градиент разрешён. Текстовый градиент `.text-gradient-brand` для логотипа/вордмарка — тоже ок (это текст, не блок).
- **Тени запрещены.** `box-shadow`/`drop-shadow`/`filter: drop-shadow` не использовать для блоков и карточек. Исключение — фокус-ринги/доступность (`:focus-visible`) и бренд-кнопки если того требует кит; декоративные `shadow-*`/`shadow-brand-glow` на блоках — нельзя.
- **CSS-трансформации запрещены.** `transform`/`translate`/`scale`/`rotate`/`skew` и `transition: transform` не применять к блокам/карточкам для декора (hover-подъёмы, наклоны и т.п. — нельзя). Разрешены только трансформации, требуемые доступностью/китом (Radix `DropdownMenu`/`Drawer` анимации, `Sidebar` chevron — уже в `globals.css`).

## 4. Структура шелла

```tsx
<div className="app-shell-container mx-auto w-full max-w-none px-2"> // full-width, 8px по бокам
  <div className="app-shell">                              // grid
    <Header shape="rounded" />                            // row 1: header header
    <Sidebar />                                           // row 2 col 1
    <Content />                                           // row 2 col 2
  </div>
</div>
```

- Контейнер — `mx-auto w-full max-w-none px-2` + CSS
  `.app-shell-container { max-width: none; margin-inline: auto;
  padding-inline: 0.5rem; box-sizing: border-box }`: full-width
  без лимита, минимальные боковые 8px, центрирование. Внутренний
  `.app-shell` держит `padding-inline: 0` (боковые даёт контейнер,
  без удвоения) и `max-width: 100% + box-sizing` — без горизонтального
  скролла. Кит 0.25.9 в entry `components`/`widgets` **не экспортирует**
  layout-`Container` (только `ChartContainer` в full/widgets) —
  отдельный импорт не делаем, только классы. Если кит добавит
  `Container` — заменить внешнюю обёртку на него.
- Kit Header — чистый бар без обёртки (0.25.9: `variant`/`wide`/враппер
  удалены, остался `shape`: `rounded` = бордер + радиус + клиппинг,
  `sharp` = квадрат без бордера, default `sharp` — всегда передаём
  `shape="rounded"`): sticky-пин (`position: sticky`,
  `top: var(--header-sticky-top)`) задаёт шелл в `globals.css`
  (`.app-shell > .app-header`), ширина — шеллом, flatten-селекторы
  запрещены (см. правило радиусов ниже).
- Grid: `row1: header header / row2: sidebar content`, `gap: 1rem`
  (гаттеры, чтобы скругления были видны), `300px + 1fr`.
- Content full-width: `.app-content { width: 100%; min-width: 0 }` (grid-area
  content, скролл только здесь) + `.page-inner { width: 100%; max-width: none;
  margin: 0; padding: 1.5rem 1rem; box-sizing: border-box }` — без центрирования
  (ex-`max-width: 56rem` + auto-margins удалены), внутренний отступ как
  у `.app-sidebar` (1.5rem 1rem). Grid/sidebar/header не трогать.
- Обёртке Header назначаем только `grid-area: header` (+ sticky-пин —
  см. выше). Селектор держим двойным (`.app-shell > div:has(> .app-header)`
  для ≤0.25.8 + `.app-shell > .app-header` для 0.25.9) — бар
  (`sm:rounded-xl`, `bg-card/80`) остаётся родным.
  `wide` у Header больше нет — внутренность `w-full` задаёт сам кит,
  внешнее центрирование задаёт контейнер.
- `body:has(.app-shell) { overflow: hidden }` — скроллится только
  `.app-content`. Mobile drawer (`.app-sidebar-drawer` + overlay) —
  не трогать, открываeтся триггером из Header (`menuToggleSlot`).
- Mobile `<768px`: одна колонка (`header / content`), aside скрыт.

## 5. Бренд

`SidebarBrand` (`src/components/layout/Sidebar.tsx`: `Image`
`/devbox-logo.png` 36 `priority` + `.logo-glow`, `DevBox` в
`.text-gradient-brand`, `t.nav.console`) — единый источник.

- Header `leadingSlot`: `<SidebarBrand />` + (title/breadcrumbs, если есть).
- Header `trailingSlot`: `{actions}` → `{user}` (внешний слот, обратная
  совместимость) → `<HeaderProfileDropdown />`
  (`src/components/profile-dropdown.tsx`: ЧИСТЫЙ кит 0.26.0 `widgets` —
  `AuthorizedUserProfile` + `UnauthorizedUserProfile`, тонкий адаптер данных
  <30 строк: `useProfile()` mock → kit `user`, `t.userMenu` en/ru → kit
  `labels`, sign-out/login → `router.push('/login')`,
  `profileHref="/profile"`; compound `ProfileDropdown.Root/Trigger/...`
  удалён, скелет — один kit-токенный `div[role=status]`)
  → `<LanguageSwitcher compact />` → `<ThemeToggleDefault />`.
  Решение: чистый `AuthorizedUserProfile`, не compound — kit уже содержит
  DropdownMenu + Header + UsagePanel + Profile/Logout actions (десктоп;
  language/theme-слоты только в mobile-Drawer, поэтому внешние
  LanguageSwitcher/ThemeToggle остаются в trailing). Язык — наш `userMenu`
  (`profile/signOut/login/noEmail`; `openMenu` удалён — триггер кита несёт
  видимое имя пользователя, aria даёт Radix; дефолты кита en перекрываются
  `labels`); тема — только токены кита, без hex. a11y — нативный Radix
  кита (Esc/Tab, фокус-ринг, `aria-haspopup`/`expanded`, `Content title` —
  sr-заголовок mobile-Drawer). Известный баг кита: desktop
  `ProfileDropdown.Action` — plain function component в
  `DropdownMenuItem asChild`, Slot роняет role=menuitem/roving/item-refs —
  Arrow-навигация крашит Radix `focusFirst` (документировано в
  `profile-dropdown.test.tsx`, ждёт патча кита).
- Desktop `aside`: только `<SidebarNav />`, бренда нет.
- Mobile drawer: свой `<SidebarBrand />`-фолбэк + кнопка закрытия.
- i18n `en`/`ru` через `useI18n`, URL плоские (кука `devbox-locale`).

## 6. Плоский Content, без вложенных обводок

Внутри `.app-content` / `.page-inner` запрещены вложенные `Card`
с `border` / `background`, отличным от `transparent` — страница
линейная, без визуальных вложенностей с обводками/внутренними
отступами/другим `background` (антипаттерн: `Card` в `Card`,
`Card brand/interactive` вокруг списка, `Card` на строку).

Только линейный список: заголовок секции (`h2` + `p.text-muted-foreground`),
строки (`ul`/`li` или `div` rows), разделители `Separator`, `Badge` статуса
и `Button` actions inline без обёрток. Вообще без `Card`-обёрток
во вложениях — один уровень `Card` как «страница-контейнер» тоже запрещён,
только семантические токены (`var(--border)`, `var(--muted)` и т.д.
для разделителей/текста).

`Empty`/`Loading` (`states.tsx`) — плоские, без `Card`/`border`/`background`
(`Empty className="border-0 bg-transparent shadow-none"`, `LoadingState` —
`status-grid` из `Card`-скелетонов только для хабов и гридов данных, иначе
плоский список скелетонов).

### Исключение: карточки данных

`Card` с `border`/`background` допустима, когда это карточка сущности для
вывода данных — строка данных (проект в `/projects`, репозиторий, пакет,
сессия и т.д., пример: `Card` в `status-grid` на `/projects` — ок).
Недопустимо, когда это не карточка, а целый блок сообщения/пустого
состояния (`EmptyState` с *No project yet* / *No data* — должна быть плоской,
без `Card`/`border`/`background`, только `Empty` + `Button` inline).
Исключение — `ErrorBoundary`/`ErrorState` (`Alert variant="destructive"` в
`states.tsx`): ему разрешён бордер/фон как системному сообщению об ошибке.

Hex — только `:root` / `.dark`, радиусы — только `var(--radius*)`.
Grid/sidebar/header/drawer не трогать.

### Исключение: хабы

Хаб-страницы (`/registry`, будущие storages/databases) — единственное
исключение из плоского Content: им разрешены `Card`-обёртки (по одной
на раздел — Docker/npm, S3/Volumes, Postgres/Redis, …) с прямым Next
`Link` внутри `CardTitle`. Гриды — через `.status-grid`, список карточек
рендерит reusable `RegistryHub` (`src/components/registry-hub.tsx`,
`items[]: { href, title, description }`) — тот же `items[]`-шейп
переиспользовать для storages/databases хабов. Листовые страницы
(`/registry/docker`, `/registry/npm`) остаются плоскими (§6 без исключений:
h2-строки + `Separator` + `Badge`).
