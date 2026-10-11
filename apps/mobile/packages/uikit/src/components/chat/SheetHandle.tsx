import { StyleSheet, View, useColorScheme } from "react-native"
import { colors } from "../../theme"

// Shared drag handle for all bottom sheets: a full-width, 28px-tall grab zone
// with a centered pill (the stock handle's ~24px zone is hard to catch, and
// its accessible/adjustable wrapper has been implicated in missed grabs on
// some Android builds). BottomSheet's container attaches the pan gesture
// around ANY handleComponent, so this only changes the visuals + hit area —
// dragging between snap points and pan-down-to-close keep working as before.
export function SheetHandle() {
  const isDark = useColorScheme() === "dark"
  return (
    <View style={s.handle} testID="sheet-handle">
      <View style={[s.pill, isDark && s.pillDark]} />
    </View>
  )
}

const s = StyleSheet.create({
  handle: {
    width: "100%",
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    width: 48,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.neutral.gray200,
  },
  pillDark: {
    backgroundColor: colors.neutral.gray500,
  },
})
