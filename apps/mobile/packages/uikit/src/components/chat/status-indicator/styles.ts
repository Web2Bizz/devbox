import { StyleSheet } from "react-native"

export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const BRAILLE_INTERVAL_MS = 80
export const TICK_LOOP_MS = BRAILLE_FRAMES.length * BRAILLE_INTERVAL_MS

export const SHIMMER_DURATION_MS = 1600
export const BAND_W = 48

export const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 36,
    backgroundColor: "transparent",
  },
  barPlaceholder: { height: 36 },
  barDark: { backgroundColor: "transparent" },
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
  labelMask: { flex: 1, height: 36 },
  labelMaskInner: { flex: 1, justifyContent: "center" },
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
