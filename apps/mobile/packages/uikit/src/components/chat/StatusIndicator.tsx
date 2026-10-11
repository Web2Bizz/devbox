import { memo, useEffect } from "react"
import { View, Text, StyleSheet, type StyleProp, type TextStyle } from "react-native"
import MaskedView from "@react-native-masked-view/masked-view"
import { LinearGradient } from "expo-linear-gradient"
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated"
import { useTranslation } from "react-i18next"

// Классический терминальный спиннер точками Брайля — вместо системного
// кружка показывает, что агент работает.
//
// Никакого React-состояния: и кадры, и шиммер едут на UI-потоке через shared
// values, JS-поток их не дёргает даже под нагрузкой стриминга.
// (Раньше тик шёл через setInterval+setState — под ререндерами списка кадров
// интервал плыл; а шиммер гнался через animatedProps start/end градиента,
// которые expo-linear-gradient не анимирует — полоса стояла за кадром.)
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const BRAILLE_INTERVAL_MS = 80
const TICK_LOOP_MS = BRAILLE_FRAMES.length * BRAILLE_INTERVAL_MS

// Шиммер подписи как у ИИ-чатов: сплошная серая база + бегущая белая полоса
// фиксированной ширины с мягкими краями. Движется только transform (translateX)
// пинг-понгом — разворота нет, обёртка значения не нужна.
const SHIMMER_DURATION_MS = 1600
const BAND_W = 48

// Один кадр спиннера: видимость — из UI-потокового счётчика, без ререндеров.
// Первый кадр в потоке задаёт размер бокса, остальные лежат поверх absolute.
const FrameGlyph = memo(function FrameGlyph({
  glyph,
  index,
  tick,
  textStyle,
}: {
  glyph: string
  index: number
  tick: SharedValue<number>
  textStyle: StyleProp<TextStyle>
}) {
  const frameStyle = useAnimatedStyle(() => ({
    opacity: Math.floor(tick.value / BRAILLE_INTERVAL_MS) % BRAILLE_FRAMES.length === index ? 1 : 0,
  }))
  return (
    <Animated.Text style={[s.spinner, textStyle, index > 0 && s.glyphOverlay, frameStyle]}>
      {glyph}
    </Animated.Text>
  )
})

const BrailleSpinner = memo(function BrailleSpinner({
  tick,
  isDark,
}: {
  tick: SharedValue<number>
  isDark: boolean
}) {
  return (
    <View style={s.spinnerBox}>
      {BRAILLE_FRAMES.map((glyph, index) => (
        <FrameGlyph
          key={glyph}
          glyph={glyph}
          index={index}
          tick={tick}
          textStyle={isDark ? s.textDark : null}
        />
      ))}
    </View>
  )
})

// Server-reported session status, read by the parent from its own store and
// passed in — the kit never imports app zustand stores (which do not exist
// in the package). Extra fields on the caller's status object are fine.
export interface StatusSnapshot {
  type: string
  attempt?: number
}

interface Props {
  status?: StatusSnapshot
  statusText?: string
  optimistic?: boolean
  isDark: boolean
}

export function StatusIndicator({ status, statusText, optimistic, isDark }: Props) {
  const { t } = useTranslation()

  // Server status is the source of truth, but the optimistic `sending` flag
  // must also count on its own: it bridges the gap between the user tapping
  // send and the server confirming busy (including a stale `idle` left over
  // from the previous run). Once the server reports idle for the current
  // run, the parent clears `sending` too, so `sseBusy || optimistic` can't
  // get stuck.
  const sseBusy = !!status && status.type !== "idle"
  const busy = sseBusy || optimistic

  // Счётчик кадров спиннера — пила 0→800ms на UI-потоке, ререндеров нет.
  // Маунтится только пока busy (в простое — плейсхолдер ниже).
  const tick = useSharedValue(0)
  useEffect(() => {
    if (!busy) return
    tick.value = withRepeat(
      withTiming(TICK_LOOP_MS, { duration: TICK_LOOP_MS, easing: Easing.linear }),
      -1,
      false,
    )
    return () => cancelAnimation(tick)
  }, [busy, tick])

  // Прогон шиммера пинг-понгом 0→1 на UI-потоке; ширина подписи снимается
  // один раз через onLayout в shared value (без ререндера).
  const sweep = useSharedValue(0)
  const labelW = useSharedValue(0)
  useEffect(() => {
    if (!busy) return
    sweep.value = withRepeat(
      withTiming(1, { duration: SHIMMER_DURATION_MS, easing: Easing.linear }),
      -1,
      true,
    )
    return () => cancelAnimation(sweep)
  }, [busy, sweep])
  const bandStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -BAND_W + sweep.value * (labelW.value + BAND_W) }],
  }))

  if (!busy) return <View style={s.barPlaceholder} />

  const label =
    status?.type === "retry" && typeof status.attempt === "number"
      ? t("chat.statusIndicator.retrying", { attempt: status.attempt })
      : statusText || t("chat.statusIndicator.working")
  // База шиммера — цвет подписи в текущей теме, полоса — белая.
  const shimmerBase = isDark ? "#888888" : "#666666"

  return (
    <View style={[s.bar, isDark && s.barDark]}>
      <BrailleSpinner tick={tick} isDark={isDark} />
      {/* Маска вырезает слои строго по форме букв — полоса бежит
          только по тексту, а не прямоугольником поверх строки. */}
      <MaskedView
        style={s.labelMask}
        maskElement={
          <View style={s.labelMaskInner}>
            <Text style={s.maskText}>{label}</Text>
          </View>
        }
      >
        <View
          style={s.labelFill}
          onLayout={(e) => {
            labelW.value = e.nativeEvent.layout.width
          }}
        >
          <View style={[s.labelBase, { backgroundColor: shimmerBase }]} />
          <Animated.View style={[s.band, bandStyle]}>
            <LinearGradient
              colors={["rgba(255,255,255,0)", "#ffffff", "rgba(255,255,255,0)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={s.bandGradient}
            />
          </Animated.View>
        </View>
      </MaskedView>
    </View>
  )
}

const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    // Без собственных горизонтальных отступов: бар — ListHeaderComponent
    // внутри списка, у которого уже есть padding 16. Свои paddingHorizontal
    // давали двойной отступ (32) и выбивали текст из сетки пузырей.
    height: 36,
    backgroundColor: "transparent",
  },
  barPlaceholder: { height: 36 },
  barDark: { backgroundColor: "transparent" },
  // Брайлевский спиннер: кегль крупнее подписи, цвет — как у неё.
  // Кадры лежат стопкой: первый задаёт размер, остальные поверх.
  spinner: { fontSize: 16, color: "#666666", textAlign: "center" },
  spinnerBox: { justifyContent: "center", alignItems: "center" },
  glyphOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    textAlign: "center",
    textAlignVertical: "center",
  },
  textDark: { color: "#888888" },
  // Шиммер подписи: маска занимает остаток строки; внутри — сплошная база
  // в цвет подписи и absolute-полоса, едущая по UI-потоку.
  labelMask: { flex: 1, height: 36 },
  labelMaskInner: { flex: 1, justifyContent: "center" },
  // Метрики бывшей подписи (13px/500); цвет любой непрозрачный —
  // маска смотрит только на альфу.
  maskText: { fontSize: 13, fontWeight: "500", color: "#000000" },
  labelFill: { flex: 1 },
  labelBase: { flex: 1 },
  band: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: BAND_W,
  },
  bandGradient: { flex: 1 },
})
