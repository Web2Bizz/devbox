import { memo } from "react"
import { View } from "react-native"
import { type SharedValue } from "react-native-reanimated"
import { BRAILLE_FRAMES, s } from "../status-indicator/styles"
import { FrameGlyph } from "../frame-glyph"

export const BrailleSpinner = memo(function BrailleSpinner({
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
