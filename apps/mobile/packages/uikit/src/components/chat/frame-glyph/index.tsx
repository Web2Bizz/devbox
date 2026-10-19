import { memo } from "react"
import { type StyleProp, type TextStyle } from "react-native"
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated"
import { BRAILLE_FRAMES, BRAILLE_INTERVAL_MS, s } from "../status-indicator/styles"

export const FrameGlyph = memo(function FrameGlyph({
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
