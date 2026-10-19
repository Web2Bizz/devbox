import { StyleSheet } from "react-native"
import { colors, COMPOSER_MIN_HEIGHT } from "@web2bizz/ui-native"

export const COMPOSER_PADDING = 12

export const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  loading: { flex: 1, justifyContent: "center", alignItems: "center" },
  listWrap: { flex: 1, position: "relative" },

  // Messages
  messageList: { padding: 16, paddingBottom: 8 },

  // Scroll button
  scrollBtn: {
    position: "absolute",
    bottom: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ffffff",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  scrollBtnDark: { backgroundColor: "#2a2a2a" },

  // Loading more (appears at top in inverted list = ListFooterComponent)
  loadingMore: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingVertical: 16,
  },
  loadingMoreText: { fontSize: 13, color: "#999999" },

  // Empty state overlay — sits on top of the (empty) inverted list, untransformed,
  // so its text/icon render upright and un-mirrored on Android.
  emptyOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 64,
    paddingHorizontal: 24,
  },

  // Empty
  empty: { flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 64 },
  emptyText: { fontSize: 16, color: "#999999", marginTop: 12 },
  // Quick-action chips: web flex-wrap analog — row + wrap so chips flow onto
  // the next line instead of stacking vertically.
  suggestionsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
  },
  suggestionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#f5f5f5",
  },
  suggestionChipDark: { borderColor: "#2a2a2a", backgroundColor: "#1a1a1a" },
  suggestionText: { fontSize: 14, fontWeight: "500", color: "#444444" },
  suggestionTextDark: { color: colors.textPlaceholder },
  // Follow-up strip above the composer: fixed 45px block, horizontal scroll.
  // Chips mirror suggestionChip (border + background) in a compact form to
  // fit the 45px height.
  // No dividers, transparent background — the strip floats over the list.
  followUpBar: {
    height: 45,
    justifyContent: "center",
    // Same inset as the composer field; chips start flush at the bar edge —
    // spacing lives only between chips (gap in followUpContent), not around.
    marginHorizontal: COMPOSER_PADDING,
    backgroundColor: "transparent",
  },
  followUpBarDark: { backgroundColor: "transparent" },
  followUpScroll: { height: 45 },
  followUpContent: {
    flexDirection: "row",
    alignItems: "center",
    // Только gap между чипами — без полей вокруг кнопок по краям скролла.
    gap: 8,
    height: 45,
  },
  followUpChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#f5f5f5",
  },
  followUpChipDark: { borderColor: "#2a2a2a", backgroundColor: "#1a1a1a" },
  followUpText: { fontSize: 12, fontWeight: "500", color: "#444444" },
  followUpTextDark: { color: colors.textPlaceholder },
  // Outbox button row above the composer: compact, same chip language.
  queueBar: {
    flexDirection: "row",
    justifyContent: "center",
    marginHorizontal: COMPOSER_PADDING,
    marginBottom: 8,
  },
  queueBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#f5f5f5",
  },
  queueBtnDark: { borderColor: "#2a2a2a", backgroundColor: "#1a1a1a" },
  queueBtnText: { fontSize: 13, fontWeight: "600", color: "#444444" },
  queueBtnTextDark: { color: colors.textPlaceholder },
  emptyHint: { fontSize: 13, color: colors.textPlaceholder, marginTop: 12 },
  metaDark: { color: "#666666" },
  textWhite: { color: "#ffffff" },

  // Input
  // Нижний док — fixed overlay поверх чата (квик-действия + ввод).
  // Фон прозрачный: черты нет, контейнеры не перекрывают список плашкой.
  // Высота дока замеряется (onLayout) и уходит в отступ списка.
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "transparent",
    zIndex: 2,
    elevation: 0,
  },
  dockDark: { backgroundColor: "transparent" },
  // Оверлей промптов (permission/question): перекрывает весь док поверх ввода
  // и квик-действий. Сплошной фон в цвет экрана прячет поле под собой, тапы
  // ловит сам (контент под ним недоступен, но не размонтирован). maxHeight
  // задаётся инлайном от высоты окна — длинные вопросы скроллятся внутри
  // QuestionPrompt, а не разъезжаются на весь экран.
  promptOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5,
    elevation: 5,
    justifyContent: "flex-end",
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderColor: "#e5e5e5",
  },
  promptOverlayDark: { backgroundColor: "#0a0a0a", borderColor: "#2a2a2a" },
  dockGradient: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // Тянем градиент выше верхней кромки дока, чтобы затемнение начиналось
    // плавно над квик-действиями, а не резкой чертой по их верху.
    top: -40,
  },
  inputContainer: {
    padding: COMPOSER_PADDING,
    backgroundColor: "transparent",
  },
  inputContainerDark: { backgroundColor: "transparent" },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  // Список команд: обёртка якорится к низу строки ввода (bottom: 0) и
  // продлена вниз на высоту поля (paddingBottom = высота поля − 16):
  // блок заходит за поле ввода, а палитра выходит из-под него — низ
  // поповера (~16px) прячется за непрозрачным полем (поле выше по z).
  // Растёт вверх поверх быстрых действий. В замере dockHeight не участвует.
  slashWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: 340,
    zIndex: 0,
    elevation: 0,
  },
  // Подложка открытой палитры: прозрачная, на весь список (zIndex 1 выше
  // FlatList, ниже дока zIndex 2) — перехватывает тапы/скроллы мимо палитры.
  slashBackdrop: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
  overlayBtns: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 2,
  },
  overlayGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  overlayBtn: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  // Composer spacing — single value for container padding and the input's
  // top/side insets so the field spans full width uniformly.
  input: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    borderRadius: 20,
    // Обводка как у карточек проекта (projectCard): синхронно с дизайном.
    borderWidth: 1,
    borderColor: "#e5e5e5",
    // Поле непрозрачно перекрывает низ палитры команд (slashWrap zIndex 0):
    // так палитра визуально выходит из-под блока ввода.
    zIndex: 1,
    elevation: 1,
    paddingTop: COMPOSER_PADDING,
    paddingBottom: 52,
    paddingLeft: COMPOSER_PADDING,
    paddingRight: COMPOSER_PADDING,
    fontSize: 16,
    minHeight: COMPOSER_MIN_HEIGHT,
    maxHeight: 240,
    color: "#0a0a0a",
  },
  inputDark: { backgroundColor: "#1a1a1a", color: "#ffffff", borderColor: "#2a2a2a" },
  inputListening: { borderWidth: 1, borderColor: "#ef4444" },

  // Header
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },

  // SSE reconnect/connected banner
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: "center",
  },
  bannerReconnecting: { backgroundColor: "#92400e" },
  bannerConnected: { backgroundColor: "#065f46" },
  bannerText: { color: "#ffffff", fontSize: 13, fontWeight: "500" },

  // Pending revert (edit message) banner
  bannerRevert: {
    backgroundColor: colors.accentBannerBg,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  bannerAction: { color: "#FFB199", fontSize: 13, fontWeight: "700" },

  // Bottom-sheet layer: must sit above the composer overlay buttons and the
  // scroll button (see wrapper comment at the AiSettingsModal usage). No
  // backgroundColor — so Android draws no shadow from the elevation.
  sheetLayer: {
    ...StyleSheet.absoluteFill,
    zIndex: 10,
    elevation: 10,
  },
})
