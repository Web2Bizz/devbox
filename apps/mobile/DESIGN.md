# DevBox Mobile — DESIGN

Дизайн-договорённости `apps/mobile` (Expo 57 / React Native 0.86 + React 19 +
`@web2bizz/ui-native` = `apps/mobile/packages/uikit`). Общие правила монорепо —
в корневом `DESIGN.md` (он референсный: запреты декора, принцип
`radius(child) < radius(parent)`, владение файлом). Если этот файл и корневой
расходятся — правит этот файл: он ближе к коду mobile.

Структура приложения и гейты — в `apps/mobile/AGENTS.md`.

## 1. Источник истины

Палитра, spacing, breakpoints и layout живут **в одном файле**:
`packages/uikit/src/theme.ts` (`@web2bizz/ui-native`). Это единственное место
в mobile, где hex-литералы законны.

Правило: **никогда не инлайнить hex вне `theme.ts`**. В RN-стилях
(`StyleSheet.create`, инлайн-`style`, пропсы `color`/`backgroundColor`)
ссылаемся на `colors.*` / `theme.light.*` / `theme.dark.*` из кита.

Ветка вида `isDark ? "#hex" : "#hex"` в прикладном коде — признак
невынесенной темы: значит, токен надо добавить в `theme.ts` и заменить
`isDark ? colors.X : colors.Y` (см. §4).

Новый цвет → сначала токен в `theme.ts`, потом использование. Обратный
порядок запрещён.

## 2. Токены

Все hex ниже — из `packages/uikit/src/theme.ts`, если не помечено иначе.

### 2.1 Акцент (бренд-рамп Pink → Orange, `assets/icon-source.svg`)

| Токен                    | Hex        | Роль                                          |
| ------------------------ | ---------- | --------------------------------------------- |
| `colors.accent`          | `#FF2A7A`  | primary: иконки, чекмарки, активный текст     |
| `colors.accentStrong`    | `#C81D5E`  | текст акцента на приглушённом фоне (light)   |
| `colors.accentLight`     | `#FF5E62`  | иконки/чекмарки в тёмной теме                 |
| `colors.accentPale`      | `#FF9966`  | вторичный текст на muted в тёмной теме        |
| `colors.accentExtraPale` | `#FFB199`  | tertiary-текст на тёмном muted                |
| `colors.accentMuted`     | `#FFF0EA`  | фон muted (light): выбранные строки, баннеры  |
| `colors.accentMutedDark` | `#2E1A22`  | фон muted (dark), тёплый бордо                |
| `colors.accentBorder`    | `#FFD9CC`  | бордер на светлом muted                       |
| `colors.accentBorderDark`| `#4A2633`  | бордер на тёмном muted                        |
| `colors.accentBannerDark`| `#1F1016`  | тёмный баннерный фон                          |
| `colors.accentBannerBg`  | `#7A1E43`  | глубокий magenta — фон баннера revert         |
| `colors.accentBannerText`| `#FFE4D9`  | светлый персик — текст заголовка баннера      |
| `colors.accentChipBg`    | `#FFF0EA`  | чип, light                                     |
| `colors.accentChipBgDark`| `#2E1A22`  | чип, dark                                      |

### 2.2 Нейтрали (`colors.neutral.*`)

| Токен         | Hex        |
| ------------- | ---------- |
| `white`       | `#ffffff`  |
| `gray10`      | `#fafafa`  |
| `gray25`      | `#f8f8f8`  |
| `gray50`      | `#f5f5f5`  |
| `gray100`     | `#e5e5e5`  |
| `gray150`     | `#f0f0f0`  |
| `gray200`     | `#cccccc`  |
| `gray225`     | `#dddddd`  |
| `gray300`     | `#999999`  |
| `gray400`     | `#888888`  |
| `gray450`     | `#aaaaaa`  |
| `gray500`     | `#666666`  |
| `gray600`     | `#444444`  |
| `gray700`     | `#2a2a2a`  |
| `gray750`     | `#3a3a3a`  |
| `gray800`     | `#1a1a1a`  |
| `gray850`     | `#151515`  |
| `gray900`     | `#0a0a0a`  |
| `black`       | `#000000`  |

Семантические алиасы: `backgroundLight` = `#ffffff`, `backgroundDark` =
`#0a0a0a`, `surfaceLight` = `#f5f5f5`, `surfaceLight2` = `#f8f8f8`,
`surfaceLight3` = `#f0f0f0`, `surfaceLight4` = `#fafafa`,
`surfaceDark` = `#1a1a1a`, `surfaceDark2` = `#2a2a2a`,
`surfaceDark4` = `#151515`, `borderLight` = `#e5e5e5`,
`borderLight2` = `#dddddd`, `borderDark` = `#1a1a1a`,
`borderDark2` = `#3a3a3a`, `textPrimaryLight` = `#0a0a0a`,
`textPrimaryDark` = `#ffffff`, `textSecondaryLight` = `#666666`,
`textSecondaryDark` = `#888888`, `textSecondaryAltDark` = `#aaaaaa`,
`textTertiaryLight` = `#999999`, `textTertiaryDark` = `#666666`.

Плоские алиасы баннера: `accentBannerBg` = `#7A1E43`,
`accentBannerText` = `#FFE4D9`.

### 2.3 Семантика (`colors.semantic.*`)

| Токен                | Hex        | Роль                                |
| -------------------- | ---------- | ----------------------------------- |
| `success`            | `#22c55e`  | успех, on-track                    |
| `successStrong`      | `#16a34a`  | успех, текст/иконка                |
| `error`              | `#ef4444`  | ошибка, destructive                 |
| `errorStrong`        | `#dc2626`  | ошибка, текст                       |
| `warning`            | `#f59e0b`  | предупреждение                      |
| `info`               | `#FF5E62`  | информация (= акцент светлый)       |

#### Ролевые токены (`colors.roles.*`)

Именованы по роли, а не по ступени серой шкалы. Значения — те же hex, что
раньше были инлайном в коде.

| Токен                     | Hex        | Роль                                          |
| ------------------------- | ---------- | --------------------------------------------- |
| `colors.textPlaceholder`  | `#bbbbbb`  | плейсхолдер/приглушённый текст (dark)          |
| `colors.textDisabled`     | `#555555`  | неактивный текст, disabled-пункты              |
| `colors.textMutedDark`    | `#a0a0a0`  | приглушённый вторичный текст на error-экранах |
| `colors.textCodeDark`     | `#cdd3da`  | текст кода в тёмной теме                       |
| `colors.switchTrackOff`   | `#767577`  | track выключенного RN `Switch` (одинаков в обеих темах) |
| `colors.warningSoftText`  | `#d4a574`  | янтарный «мягкий» текст предупреждения        |
| `colors.blockquoteBorderLight` | `#d1d5db` | бордер blockquote — светлая тема           |
| `colors.blockquoteBorderDark`  | `#4a4a5a` | бордер blockquote — тёмная тема            |
| `colors.codeHeaderBgLight`     | `#e8e8e8` | фон шапки блока кода (light)              |
| `colors.surfaceDeep`           | `#111111` | самая глубокая подложка в тёмной теме    |

### 2.4 Рампы состояний (легализованы здесь, токенов в `theme.ts` ещё нет)

Эти hex **реально используются** в UI-коде mobile (статусы, diff, промпты
инструментов, тосты), но в `theme.ts` их пока нет. Записаны здесь как
легализованные; **каждый следует вынести в `theme.ts`** как
`success*` / `error*` / `warning*` (см. §6.4 «долг»).

Success / green:

| Hex        | Роль                              |
| ---------- | --------------------------------- |
| `#dcfce7`  | success-подложка (light)          |
| `#bbf7d0`  | success-подложка (light, акцент)  |
| `#4ade80`  | success-текст/иконка (dark)       |
| `#052e16`  | success-подложка (dark)           |
| `#14532d`  | success-подложка (dark, акцент)   |
| `#15803d`  | success-текст (light)             |
| `#10b981`  | success-иконка                     |

Error / red:

| Hex        | Роль                              |
| ---------- | --------------------------------- |
| `#fef2f2`  | error-подложка (light)            |
| `#fecaca`  | error-подложка (light, акцент)    |
| `#fee2e2`  | error-подложка (light, мягкая)    |
| `#f87171`  | error-текст/иконка (dark)         |
| `#7f1d1d`  | error-подложка (dark)             |

Warning / amber:

| Hex        | Роль                              |
| ---------- | --------------------------------- |
| `#fef3c7`  | warning-подложка (light)          |
| `#fffbeb`  | warning-подложка (light, мягкая)  |
| `#92400e`  | warning-текст (light)             |
| `#78350f`  | warning-текст (dark)              |
| `#b45309`  | warning-текст (dark, акцент)     |
| `#065f46`  | warning/teal-текст (light)        |

Тёплые тёмные подложки (dark-тема, prompt/banner-подобные блоки). В `theme.ts`
их нет — легализованы здесь, подлежат вынесению:

| Hex        | Роль                              |
| ---------- | --------------------------------- |
| `#1a0a0a`  | тёмная подложка (light-вариант)   |
| `#2a0a0a`  | тёмная подложка (diff/блок)       |
| `#3a1a1a`  | тёмная подложка, светлее           |
| `#3f0a0a`  | тёмная подложка                   |
| `#1a1a0a`  | тёмная подложка                   |
| `#1a1800`  | тёмная подложка                   |
| `#333300`  | тёмная подложка                   |

Логотип/бренд-градиент внутри inline-SVG (лого на login/settings):

| Hex        | Роль                              |
| ---------- | --------------------------------- |
| `#f8faff`  | лого: заливка знаков              |
| `#25cd94`  | лого: стоп градиента              |
| `#188aff`  | лого: конец градиента             |

Оверлеи (затемнение под модалками/тостами). Хранятся в коде как
`rgba(...)`; в `theme.ts` токенов нет — легализованы здесь, подлежат
вынесению:

| Значение                | Роль                             |
| ----------------------- | -------------------------------- |
| `rgba(0, 0, 0, 0)`      | нейтральный overlay              |
| `rgba(0, 0, 0, 0.5)`    | scrim модалки / тоста            |
| `rgba(0, 0, 0, 0.55)`   | scrim (вариант)                  |
| `rgba(255, 255, 255, 0)` | «пустой» светлый overlay        |
| `rgba(255, 255, 255, 0.9)` | светлый overlay-90%           |

### 2.5 Spacing (`spacing`)

| Токен  | Значение |
| ------ | -------- |
| `xs`   | 4        |
| `sm`   | 8        |
| `md`   | 12       |
| `lg`   | 16       |
| `xl`   | 24       |
| `2xl`  | 32       |

### 2.6 Breakpoints (`breakpoints`)

| Токен     | Значение | Включает                              |
| --------- | -------- | ------------------------------------- |
| `tablet`  | 768      | 2 колонки + центрирование контента    |
| `desktop` | 1024     | 3 колонки                             |

### 2.7 Layout (`layout`)

| Токен                | Значение | Роль                                  |
| -------------------- | -------- | ------------------------------------- |
| `containerPadding`   | 16       | паддинг page-контейнера и header      |
| `headerRightPadding` | 16       | паддинг справа в header               |
| `headerLeftPadding`  | 16       | паддинг слева в header                |
| `contentMaxWidth`    | 640      | макс. ширина контента на планшете     |
| `formMaxWidth`       | 500      | макс. ширина формы логина             |
| `modalMaxWidth`      | 560      | макс. ширина модалок                  |

## 3. Зарегистрированные компоненты

Guard сверяет с этим списком каждое объявление компонента в UI-файлах mobile.
Новый компонент **не считается зарегистрированным**, пока его имя не
добавлено сюда.

### 3.1 Ки�� — `packages/uikit` (`@web2bizz/ui-native`)

Переиспользуемый визуал живёт только здесь. Экспорт из
`packages/uikit/src/index.ts`.

Ки��-оболочка:

- `Container`

Чат / сессия:

- `Select`
- `SheetHandle`
- `PickerSheet`
- `AiSettingsModal`
- `DirectorySwitcher`
- `DirectoryBrowserSheet`
- `MessageBubble`
- `ToolCallCard`
- `DiffView`
- `ReasoningBlock`
- `PermissionPrompt`
- `QuestionPrompt`
- `StatusIndicator`
- `SlashPopover`
- `ImageAttachments`
- `SessionInfo`
- `MessageQueueSheet`
- `LanDiscoveryModal`

Markdown:

- `Markdown`
- `CodeBlock`
- `CopyLink`

### 3.2 App-bound — `src/components`

Привязаны к сторам/серверным клиентам/проверкам релизов, в киту им не
место.

- `AuthGate`
- `ErrorBoundary`
- `ConnectionBadge`
- `RepoLinkRow`
- `UpdateBanner`
- `CloneRepoSheet`

### 3.3 Экраны (Expo Router, `app/`)

- `RootLayout`
- `TabLayout`
- `AccountScreen`
- `TasksScreen`
- `SettingsScreen`
- `LoginScreen`
- `DemoScreen`
- `NewProjectPlaceholder`
- `AddConnectionScreen`
- `SessionScreen`
- `SessionsScreen`
- `ProjectSessionsScreen`
- `ProjectRemotesScreen`

### 3.4 Внутренние компоненты экранов

Определены в экранных файлах, но переиспользуемы — при выносе в кит имя
сохраняется.

- `ProjectCard`
- `ServerRow`
- `SettingRow`
- `MetaItem`
- `TokenPill`
- `ErrorBanner`
- `NewProjectPlaceholder`
- `BrailleSpinner`
- `CustomRenderer`
- `FrameGlyph` (внутренний глиф `StatusIndicator`)

Tool/detail-подкомпоненты чата:

- `BashDetail`
- `EditDetail`
- `GlobGrepDetail`
- `GenericDetail`
- `PatchDetail`
- `ReadDetail`
- `TaskDetail`
- `TodoDetail`
- `ToolDetail`
- `WebfetchDetail`
- `WriteDetail`
- `PickerRow`

### 3.5 Нативный Android-слой

Сгенерировано `expo prebuild`, в UI-скоуп design-guard попадает как
UI-файлы; имена зарегистрированы здесь для полноты.

- `MainActivity`
- `MainApplication`

## 4. Светлая/тёмная тема

Тема выбирается из `theme.light` / `theme.dark` в `theme.ts`, а не хардкодом:

```ts
import { colors, theme } from "@web2bizz/ui-native"
import { useThemeColor } from "expo-system-ui" // или свой theme-хук приложения

const bg = isDark ? theme.dark.background : theme.light.background
const text = isDark ? theme.dark.text : theme.light.text
```

Правила:

1. Ветка `isDark ? X : Y` — только **токенами**. `isDark ? "#1a1a1a" : "#ffffff"`
   запрещена: это ровно тот случай, ради которого существует `theme.ts`.
2. Статические `StyleSheet.create` собираются внутри функции/компонента с
   `isDark` либо используют плоские `colors.*`, одинаковые в обеих темах
   (например `colors.accent`).
3. Семантика, а не вид: «поверхность» — `theme.*.surface`, «граница» —
   `theme.*.border`, «вторичный текст» — `theme.*.textSecondary`. Не брать
   `gray700` там, где нужен `surface` — иначе light/dark разъедутся.
4. Новый тёмный оттенок = новый токен в `theme.light` **и** `theme.dark`
   (или явный плоский токен, если цвет темо-независим).

## 5. Радиусы и вложенность

Принцип общий для монорепо: **`radius(child) < radius(parent)`**
(корневой `DESIGN.md` §2). Шкала уровней — там же: шелл → блок → элемент →
мелочь.

Специфика mobile: **радиусов-токенов в `theme.ts` нет**. Сейчас радиусы
задаются числами в `StyleSheet` (`borderRadius: 4 / 6 / 8 / 10 / 12 / 16`,
плюс `0` для флэт-контейнеров и `28` для pill-форм). Это долг: см. §6.4.

До появления `radius`-токенов:

- не вводить новые значения радиуса «по вкусу» — брать уже существующее в
  соседних компонентах того же уровня;
- `borderRadius: 0` — только на флэт-контейнерах, которые не вложены в
  скруглённый блок;
- pill-формы (28) — только на capsule-контролах, не на блоках.

## 6. Правила

### 6.1 Переиспользование

Переиспользуемый компонент живёт в `packages/uikit` (`@web2bizz/ui-native`).
Дублировать китовый компонент в `src/components/` запрещено
(`apps/mobile/AGENTS.md`). В `src/components/` живут только app-bound
компоненты: `AuthGate`, `CloneRepoSheet`, `ConnectionBadge`, `UpdateBanner`,
`ErrorBoundary`, `RepoLinkRow`.

### 6.2 Компонент должен быть зарегистрирован

Новый компонент (объявление `function X` / `export default function X` /
`class X`) добавляется в §3 этого файла. Экраны — в §3.3.

### 6.3 Доступность (a11y)

- Нативные примитивы RN: `Pressable` с `accessibilityRole` /
  `accessibilityLabel` / `accessibilityHint`, `accessibilityState` — вместо
  «просто `View` с `onPress`».
- Видимый фокус и достаточный размер тапа — обязательны (минимальная
  зона нажатия 44×44 по Human Interface Guidelines).
- Иконки-only кнопки обязаны иметь `accessibilityLabel`; `Ionicons` с
  `color` из токена, не из хардкода.
- Цвет не единственный носитель смысла: статус сопровождается текстом или
  иконкой (иначе не читается при дальтонизме).
- Контраст текста к фону — не ниже WCAG AA.

### 6.4 Известный долг (легализованные токены)

Часть hex из §2.4 (`#dcfce7`, `#052e16`, `#3a1a1a`, `rgba(0,0,0,0.5)`
и т.д.) и часть радиусов (§5) **не имеют токена в `theme.ts`** — они
записаны здесь только чтобы зафиксировать фактическое состояние кода и не
блокировать guard. План: вынести в `theme.ts` рампами `success*` / `error*` /
`warning*` / `overlay*` и токеном `radius`, затем удалить эту подсекцию из
DESIGN.md. Новые значения из этого долга не добавлять.

### 6.5 Закрытый долг (magic-color, 2026-10-11)

Долг по открытым magic-color **закрыт**: все 42 хардкода заменены на токены
в UI-коде mobile.

Что сделано:

1. **22 hex вынесены в `packages/uikit/src/theme.ts`** (группы `neutral.*`
   и `roles.*`) и заменены в коде на `colors.*`:
   нейтрали `gray10` / `gray25` / `gray150` / `gray225` / `gray450` /
   `gray750` (+ `gray850` как `surfaceDark4`), ролевые `textPlaceholder` /
   `textDisabled` / `textMutedDark` / `textCodeDark` / `switchTrackOff` /
   `warningSoftText` / `blockquoteBorderLight` / `blockquoteBorderDark` /
   `codeHeaderBgLight` / `surfaceDeep`. Значения не изменились — переименованы
   по роли. Полный список — §2.2 и §2.3.
2. **Акцент-баннер**: `bannerBg` `#7A1E43` и `bannerText` `#FFE4D9` добавлены
   в группу `accent` (`accent.bannerBg` / `accent.bannerText`), плоские
   экспорты — `colors.accentBannerBg` / `colors.accentBannerText`.
3. **Три внепалитровых цвета** (`violet-500`, `violet-700`, `pink-500` в
   `src/components/chat/CloneRepoSheet.tsx`) заменены на бренд-акценты
   `colors.accent` / `colors.accentStrong` / `colors.accentPale`.

Оставшийся долг — §2.4 (легализованные, но ещё не вынесенные в `theme.ts`
рампы состояний/оверлеи) и §5 (радиусы-токены). Он отдельный и этим
проходом не трогался: решение владельца — «сначала 22, остальное потом».

## 7. Владение

- **Владелец — человек.** Агенты читают этот файл перед правками UI,
  предлагают изменения (патч: секция → строки) и ждут approve; правило
  считается принятым только после коммита владельцем.
- Порядок: агент предлагает правку с обоснованием → человек вносит и
  approve → коммит.
- Изменения палитры начинаются с `packages/uikit/src/theme.ts`, изменения
  правил — с этого файла.

### Журнал решений

| Дата       | Решение                                                                 | Контекст / источник                                                                 |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 2026-10-11 | Magic-color долг закрыт: 22 hex вынесены в `packages/uikit/src/theme.ts` (нейтрали `gray10/25/150/225/450/750/850` + ролевые токены `textPlaceholder`, `textDisabled`, `textMutedDark`, `textCodeDark`, `switchTrackOff`, `warningSoftText`, `blockquoteBorderLight/Dark`, `codeHeaderBgLight`, `surfaceDeep`) и все 42 хардкода заменены в коде; §6.5 переписан из «Открытые magic-color» в «Закрытый долг» | Решение владельца «сначала 22, остальное потом»: §2.4 (легализованные, но не вынесенные в `theme.ts` рампы/оверлеи) и §5 (радиусы-токены) остаются отдельным долгом; три внепалитровых (`violet-500/700`, `pink-500`) переведены на `colors.accent` / `accentStrong` / `accentPale` |
| 2026-10-11 | Создан `apps/mobile/DESIGN.md` при переезде приложения в монорепо `apps/mobile`: палитра §2 скопирована из `packages/uikit/src/theme.ts`, §3 — реестр компонентов из `guard.sh --staged --json`, §2.4 зафиксировал легализованные, но ещё не вынесенные в `theme.ts` hex | До файла mobile валидировался против корневого web-`DESIGN.md` и давал 1025 нарушений (957 magic-color, 67 unregistered-component); source of truth — `theme.ts` + реальные литералы UI-кода |