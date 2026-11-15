import { useEffect } from "react"
import { View, Text } from "react-native"
import MaskedView from "@react-native-masked-view/masked-view"
import { LinearGradient } from "expo-linear-gradient"
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated"
import { useTranslation } from "react-i18next"

import { BrailleSpinner } from "../braille-spinner"
import {
  BAND_W,
  SHIMMER_DURATION_MS,
  TICK_LOOP_MS,
  s,
} from "./styles"

export type StatusSnapshot = {
  type: string
  attempt?: number
}

type Props = {
  status?: StatusSnapshot
  statusText?: string
  optimistic?: boolean
  isDark: boolean
}

export function StatusIndicator({ status, statusText, optimistic, isDark }: Props) {
  const { t } = useTranslation()

  const sseBusy = !!status && status.type !== "idle"
  const busy = sseBusy || optimistic

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
  const shimmerBase = isDark ? "#888888" : "#666666"

  return (
    <View style={[s.bar, isDark && s.barDark]}>
      <BrailleSpinner tick={tick} isDark={isDark} />
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
