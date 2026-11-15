/**
 * Centralized color palette for opencode-mobile.
 *
 * Goals:
 * - Single source of truth for every hex literal scattered across app/ and src/.
 * - Accent follows the CLI 5-stop RUSH CODE brand scale
 *   (#FFB02E -> #FF4A2D -> #E93A6B -> #8B3DFF -> #2E9BFF, see assets/icon-source.svg
 *   and apps/cli/src/ui/screens/home/constants.ts HOME_TITLE_STOPS).
 * - Provide light/dark-aware tokens so `isDark ? X : Y` branches become
 *   `isDark ? colors.accentDark : colors.accent` instead of raw hexes.
 *
 * Structure: flat `colors` object grouped by role. Each group keeps the raw
 * hex so StyleSheet.create can reference it directly without extra runtime.
 * `theme.light` / `theme.dark` expose semantic aliases for callers that prefer
 * a theme object.
 *
 * When adding a new color, extend this file — never inline a hex elsewhere.
 */

// ── Accent — CLI 5-stop brand scale (warm yellow → red-orange → pink → violet → blue) ─────────────
// Former pink/orange ramp removed: #FF2A7A #FF5E62 #FF9966 (3-stop, 135deg).
// Former blue values removed: #2563eb #1d4ed8 #3b82f6 #60a5fa #93c5fd
// #eff6ff #dbeafe #1e293b #334155 #0f172a
// (Hue 217-221 (blue) → 340 (pink) / 15-20 (orange).)
const accent = {
  /** Primary accent — middle pink stop of the CLI scale (#E93A6B). Best white-text contrast of the saturated stops on both themes (yellow #FFB02E fails on light, sky #2E9BFF is weaker as primary); direct hue heir of the old icon pink #FF2A7A. */
  DEFAULT: "#E93A6B",
  /** Stronger variant for text on muted bg, light theme. Darkened primary. */
  strong: "#A91E52",
  /** Lighter for dark theme icons / checkmarks. CLI scale stop 2 (red-orange). */
  light: "#FF4A2D",
  /** Pale for dark theme secondary text on muted. CLI scale stop 4 (violet). */
  pale: "#8B3DFF",
  /** Extra pale for dark muted text. CLI scale stop 5 (blue). */
  extraPale: "#2E9BFF",
  /** Muted bg — selected rows, banners, chips on light. Primary tint. */
  muted: "#FDEFF3",
  /** Muted bg — dark. Warm maroon. */
  mutedDark: "#2B1522",
  /** Border on light muted bg. Primary tint edge. */
  border: "#F5C6D4",
  /** Border on dark muted bg. Warm maroon edge. */
  borderDark: "#4A2536",
  /** Глубокий magenta — фон баннера revert (session/[id]). */
  bannerBg: "#7A1E43",
  /** Светлый персик — цвет ТЕКСТА заголовка баннера (UpdateBanner, dark). */
  bannerText: "#FFE4D9",
  /** Banner dark bg. Warm near-black (matches app.json adaptiveIcon/splash). */
  bannerDark: "#1F1016",
  /** Chip bg light/dark alias — kept explicit for call sites. */
  chipBg: "#FDEFF3",
  chipBgDark: "#2B1522",
} as const

// ── Neutral — grays / backgrounds used throughout the app ────────────────────
const neutral = {
  white: "#ffffff",
  /** Почти-белый — подложка карточки/диффа (DiffView). */
  gray10: "#fafafa",
  /** Светлая подложка строки, светлее gray50 (SessionInfo). */
  gray25: "#f8f8f8",
  gray50: "#f5f5f5",
  gray100: "#e5e5e5",
  /** Подложка превью изображения (ImageAttachments). */
  gray150: "#f0f0f0",
  gray200: "#cccccc",
  /** Светлый бордер/приглушённая иконка (disabled chevron в light). */
  gray225: "#dddddd",
  gray300: "#999999",
  gray400: "#888888",
  /** Приглушённый вторичный текст в тёмной теме (meta-значения). */
  gray450: "#aaaaaa",
  gray500: "#666666",
  gray600: "#444444",
  gray700: "#2a2a2a",
  /** Бордер строки/секции в тёмной теме — между gray700 и gray800. */
  gray750: "#3a3a3a",
  gray800: "#1a1a1a",
  /** Глубокая тёмная подложка (главный экран, composer). */
  gray850: "#151515",
  gray900: "#0a0a0a",
  black: "#000000",
} as const

// ── Spacing / Layout — единый контейнер для Header и контента ───────────────
// До этого в проекте не было ни <Header>, ни <Container>: каждый экран задавал
// padding: 16 / paddingHorizontal: 16 вручную, а Tabs header (expo-router)
// рендерил headerRight без отступа справа. Теперь все горизонтальные отступы
// синхронизированы через один токен.
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
} as const

export const breakpoints = {
  /** Планшетная ширина — с неё включаются 2 колонки и центрирование контента. */
  tablet: 768,
  /** Десктопная ширина — с неё включаются 3 колонки. */
  desktop: 1024,
} as const

export const layout = {
  /** Горизонтальный паддинг page-контейнера и header-контейнера. Следовать ему — значит badge в Header выравнивается с контентом. */
  containerPadding: 16,
  headerRightPadding: 16,
  headerLeftPadding: 16,
  /** Максимальная ширина центрированного контента на планшете (экраны, ScrollView). */
  contentMaxWidth: 640,
  /** Максимальная ширина формы логина на планшете. */
  formMaxWidth: 500,
  /** Максимальная ширина модалок на планшете. */
  modalMaxWidth: 560,
} as const

// ── Semantic ─────────────────────────────────────────────────────────────────
const semantic = {
  success: "#22c55e",
  successStrong: "#16a34a",
  error: "#ef4444",
  errorStrong: "#dc2626",
  warning: "#f59e0b",
  info: "#2E9BFF",
} as const

// ── Roles — токены по смыслу, а не по «степени серого» ──────────────────────
// Каждый hex ниже взят из конкретного места в коде и переименован по своей
// роли. Значение (вид) не меняется — оно то же, что раньше было инлайном.
const roles = {
  /** Плейсхолдер / приглушённый текст в тёмной теме. */
  textPlaceholder: "#bbbbbb",
  /** Неактивный/выключенный текст: disabled-пункты, приглушённые иконки. */
  textDisabled: "#555555",
  /** Приглушённый вторичный текст на error-экранах (ErrorBoundary subtitle). */
  textMutedDark: "#a0a0a0",
  /** Текст кода в тёмной теме (ErrorBoundary code). */
  textCodeDark: "#cdd3da",
  /** Track выключенного RN Switch — одинаков в light и dark. */
  switchTrackOff: "#767577",
  /** Янтарный «мягкий» текст предупреждения (PermissionPrompt, ReasoningBlock). */
  warningSoftText: "#d4a574",
  /** Бордер blockquote — светлая тема. */
  blockquoteBorderLight: "#d1d5db",
  /** Бордер blockquote — тёмная тема. */
  blockquoteBorderDark: "#4a4a5a",
  /** Фон шапки блока кода — светлая тема (CodeBlock header). */
  codeHeaderBgLight: "#e8e8e8",
  /** Самая глубокая подложка в тёмной теме — контейнер SessionInfo (dark). */
  surfaceDeep: "#111111",
} as const

// ── Flat export — preferred for StyleSheet / inline color props ──────────────
export const colors = {
  // accent
  accent: accent.DEFAULT,
  accentStrong: accent.strong,
  accentLight: accent.light,
  accentPale: accent.pale,
  accentExtraPale: accent.extraPale,
  accentMuted: accent.muted,
  accentMutedDark: accent.mutedDark,
  accentBorder: accent.border,
  accentBorderDark: accent.borderDark,
  accentBannerDark: accent.bannerDark,
  accentChipBg: accent.chipBg,
  accentChipBgDark: accent.chipBgDark,
  accentBannerBg: accent.bannerBg,
  accentBannerText: accent.bannerText,

  // neutral aliases (short names for frequent use)
  white: neutral.white,
  black: neutral.black,
  backgroundLight: neutral.white,
  backgroundDark: neutral.gray900,
  surfaceLight: neutral.gray50,
  surfaceLight2: neutral.gray25,
  surfaceLight3: neutral.gray150,
  surfaceLight4: neutral.gray10,
  surfaceDark: neutral.gray800,
  surfaceDark2: neutral.gray700,
  borderDark2: neutral.gray750,
  surfaceDark4: neutral.gray850,
  surfaceDeep: roles.surfaceDeep,
  borderLight: neutral.gray100,
  borderLight2: neutral.gray225,
  borderDark: neutral.gray800,
  textPrimaryLight: neutral.gray900,
  textPrimaryDark: neutral.white,
  textSecondaryLight: neutral.gray500,
  textSecondaryDark: neutral.gray400,
  textSecondaryAltDark: neutral.gray450,
  textTertiaryLight: neutral.gray300,
  textTertiaryDark: neutral.gray500,

  // semantic
  success: semantic.success,
  successStrong: semantic.successStrong,
  error: semantic.error,
  errorStrong: semantic.errorStrong,
  warning: semantic.warning,
  info: semantic.info,

  // roles — по смыслу, не по ступени серой шкалы
  textPlaceholder: roles.textPlaceholder,
  textDisabled: roles.textDisabled,
  textMutedDark: roles.textMutedDark,
  textCodeDark: roles.textCodeDark,
  switchTrackOff: roles.switchTrackOff,
  warningSoftText: roles.warningSoftText,
  blockquoteBorderLight: roles.blockquoteBorderLight,
  blockquoteBorderDark: roles.blockquoteBorderDark,
  codeHeaderBgLight: roles.codeHeaderBgLight,

  // groups for iteration
  accentGroup: accent,
  neutral: neutral,
  semantic: semantic,
  roles: roles,
} as const

// ── Theme object — light / dark semantic mapping ────────────────────────────
export const theme = {
  light: {
    background: neutral.white,
    surface: neutral.gray50,
    surfaceAlt: neutral.gray25,
    surfaceHover: neutral.gray100,
    border: neutral.gray100,
    borderAlt: neutral.gray225,
    text: neutral.gray900,
    textSecondary: neutral.gray500,
    textTertiary: neutral.gray300,
    textMuted: neutral.gray450,
    accent: accent.DEFAULT,
    accentStrong: accent.strong,
    accentMuted: accent.muted,
    accentBorder: accent.border,
    accentBannerBg: accent.bannerBg,
    accentChipBg: accent.chipBg,
    blockquoteBorder: roles.blockquoteBorderLight,
    codeHeaderBg: roles.codeHeaderBgLight,
  },
  dark: {
    background: neutral.gray900,
    surface: neutral.gray800,
    surfaceAlt: neutral.gray750,
    surfaceDeep: roles.surfaceDeep,
    surfaceHover: neutral.gray700,
    border: neutral.gray800,
    text: neutral.white,
    textSecondary: neutral.gray400,
    textTertiary: neutral.gray500,
    textMuted: roles.textMutedDark,
    textPlaceholder: roles.textPlaceholder,
    textDisabled: roles.textDisabled,
    codeText: roles.textCodeDark,
    accent: accent.light,
    accentPale: accent.pale,
    accentExtraPale: accent.extraPale,
    accentMuted: accent.mutedDark,
    accentBorder: accent.borderDark,
    accentBannerText: accent.bannerText,
    accentChipBg: accent.chipBgDark,
    blockquoteBorder: roles.blockquoteBorderDark,
  },
} as const

export type Colors = typeof colors
export type Theme = typeof theme
export type AccentColors = typeof accent
export type RoleColors = typeof roles
export type Spacing = typeof spacing
export type Breakpoints = typeof breakpoints
export type Layout = typeof layout
