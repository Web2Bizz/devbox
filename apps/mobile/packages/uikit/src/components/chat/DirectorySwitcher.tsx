import { useState, useCallback, useMemo } from "react"
import { View, Text, TouchableOpacity, StyleSheet, Keyboard, useWindowDimensions } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useTranslation } from "react-i18next"
import { colors } from "../../theme"
import { shouldCapSheetContent, sheetContentCap } from "../../utils/sheet-layout"
import { SheetHandle } from "./SheetHandle"

interface Props {
  sheetRef: React.RefObject<BottomSheet | null>
  current?: string
  recents: string[]
  serverHome: string | null
  isDark: boolean
  onSwitch: (directory?: string) => void
  // Opens a browsable folder picker rooted at the server's filesystem, as an
  // alternative to typing a path. Optional so existing callers keep working.
  onBrowse?: () => void
}

export function DirectorySwitcher({ sheetRef, current, recents, serverHome, isDark, onSwitch, onBrowse }: Props) {
  const { t } = useTranslation()
  const [custom, setCustom] = useState("")

  // Wide-screen centered column so rows don't stretch across a tablet.
  const { width: winWidth } = useWindowDimensions()
  const capContent = shouldCapSheetContent(winWidth)

  const handleSelect = useCallback(
    (dir?: string) => {
      // Custom-path field may hold focus — hide the keyboard so it doesn't
      // linger over the closing sheet or the next stacked one.
      Keyboard.dismiss()
      onSwitch(dir)
      setCustom("")
      sheetRef.current?.close()
    },
    [onSwitch, sheetRef],
  )

  const handleCustomSubmit = useCallback(() => {
    const dir = custom.trim()
    if (!dir) return
    handleSelect(dir)
  }, [custom, handleSelect])

  // Build list: server default + recents (excluding current)
  const items = useMemo(() => {
    const list: Array<{ label: string; dir?: string; active: boolean }> = [
      { label: t("chat.directorySwitcher.serverDefaultLabel"), dir: undefined, active: !current },
    ]
    for (const dir of recents) {
      if (dir === current) continue
      const short = dir.split("/").filter(Boolean).pop() || dir
      list.push({ label: short, dir, active: false })
    }
    return list
  }, [recents, current, t])

  const shortCurrent = current ? current.split("/").filter(Boolean).pop() || current : null

  // Static detents + backdrop are memoized: inline literals would get a fresh
  // identity on every render (and this sheet re-renders with its parent),
  // which remounts the backdrop and can interrupt an in-progress drag.
  const snapPoints = useMemo(() => ["45%", "70%"], [])
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  )

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      // See DirectoryBrowserSheet.tsx for why this is required alongside
      // static snapPoints (issue #104): without it the sheet can never open.
      enableDynamicSizing={false}
      enablePanDownToClose
      // Explicit (true by default): the handle pill must stay draggable.
      enableHandlePanningGesture
      handleComponent={SheetHandle}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={isDark ? s.sheetDark : s.sheet}
      backdropComponent={renderBackdrop}
      onChange={(idx) => {
        if (idx === -1) setCustom("")
      }}
    >
      <View style={[s.header, capContent && sheetContentCap]}>
        <Text style={[s.title, isDark && s.white]}>{t("chat.directorySwitcher.title")}</Text>
        {shortCurrent && (
          <View style={s.current}>
            <Ionicons name="folder" size={14} color={colors.accent} />
            <Text style={s.currentText} numberOfLines={1}>
              {shortCurrent}
            </Text>
          </View>
        )}
      </View>

      {/* Custom directory input */}
      <View style={[s.inputWrap, capContent && sheetContentCap]}>
        <BottomSheetTextInput
          style={[s.input, isDark && s.inputDark]}
          placeholder={serverHome ? `${serverHome}/...` : "/path/to/project"}
          placeholderTextColor={isDark ? "#666666" : "#999999"}
          value={custom}
          onChangeText={(text) => {
            if (serverHome && text === "~") setCustom(serverHome)
            else if (serverHome && text.startsWith("~/")) setCustom(serverHome + text.slice(1))
            else setCustom(text)
          }}
          onSubmitEditing={handleCustomSubmit}
          returnKeyType="go"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {custom.trim() && (
          <TouchableOpacity style={[s.goBtn, isDark && s.goBtnDark]} onPress={handleCustomSubmit}>
            <Ionicons name="arrow-forward" size={18} color={isDark ? "#0a0a0a" : "#ffffff"} />
          </TouchableOpacity>
        )}
      </View>

      {/* Quick path chips */}
      {(serverHome || onBrowse) && (
        <View style={[s.chips, capContent && sheetContentCap]}>
          {serverHome && (
            <>
              <TouchableOpacity style={[s.chip, isDark && s.chipDark]} onPress={() => setCustom(serverHome)}>
                <Text style={[s.chipText, isDark && s.chipTextDark]}>~</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.chip, isDark && s.chipDark]} onPress={() => setCustom(serverHome + "/")}>
                <Text style={[s.chipText, isDark && s.chipTextDark]}>~/</Text>
              </TouchableOpacity>
            </>
          )}
          {onBrowse && (
            <TouchableOpacity
              style={[s.chip, s.chipBrowse, isDark && s.chipDark]}
              onPress={() => {
                Keyboard.dismiss()
                sheetRef.current?.close()
                onBrowse()
              }}
            >
              <Ionicons name="folder-open-outline" size={14} color={isDark ? colors.accentPale : colors.accentStrong} />
              <Text style={[s.chipText, isDark && s.chipTextDark]}>{t("chat.directorySwitcher.browseLabel")}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Recent directories */}
      <BottomSheetFlatList
        data={items}
        keyExtractor={(item: (typeof items)[number], i: number) => item.dir || `default-${i}`}
        renderItem={({ item }: { item: (typeof items)[number] }) => (
          <TouchableOpacity
            style={[s.row, isDark && s.rowDark, item.active && s.rowActive, capContent && sheetContentCap]}
            onPress={() => handleSelect(item.dir)}
          >
            <View style={s.rowIcon}>
              <Ionicons
                name={item.dir ? "folder-outline" : "server-outline"}
                size={20}
                color={item.active ? colors.accent : isDark ? "#888888" : "#666666"}
              />
            </View>
            <View style={s.rowContent}>
              <Text style={[s.rowLabel, isDark && s.white, item.active && s.rowLabelActive]} numberOfLines={1}>
                {item.label}
              </Text>
              {item.dir && (
                <Text style={[s.rowPath, isDark && s.dimDark]} numberOfLines={1}>
                  {item.dir}
                </Text>
              )}
              {!item.dir && (
                <Text style={[s.rowPath, isDark && s.dimDark]}>{t("chat.directorySwitcher.usesServerDir")}</Text>
              )}
            </View>
            {item.active && <Ionicons name="checkmark-circle" size={20} color={colors.accent} />}
          </TouchableOpacity>
        )}
        contentContainerStyle={s.list}
        ListHeaderComponent={
          items.length > 1 ? (
            <Text style={[s.section, isDark && s.dimDark, capContent && sheetContentCap]}>
              {t("chat.directorySwitcher.recentProjectsLabel")}
            </Text>
          ) : null
        }
      />
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  sheet: { backgroundColor: "#ffffff" },
  sheetDark: { backgroundColor: "#1a1a1a" },
  header: { paddingHorizontal: 16, paddingBottom: 8, gap: 6 },
  title: { fontSize: 18, fontWeight: "700", color: "#0a0a0a" },
  white: { color: "#ffffff" },
  current: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  currentText: {
    fontSize: 13,
    color: colors.accent,
    fontWeight: "500",
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  chips: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.accentChipBg,
    borderRadius: 16,
  },
  chipDark: {
    backgroundColor: colors.accentChipBgDark,
  },
  chipBrowse: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.accentStrong,
  },
  chipTextDark: {
    color: colors.accentExtraPale,
  },
  input: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: "#0a0a0a",
  },
  inputDark: { backgroundColor: "#2a2a2a", color: "#ffffff" },
  goBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#0a0a0a",
    justifyContent: "center",
    alignItems: "center",
  },
  goBtnDark: { backgroundColor: "#ffffff" },
  list: { paddingBottom: 40 },
  section: {
    fontSize: 12,
    fontWeight: "700",
    color: "#999999",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  dimDark: { color: "#666666" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5e5",
    gap: 12,
  },
  rowDark: { borderBottomColor: "#2a2a2a" },
  rowActive: { backgroundColor: colors.accentMuted },
  rowIcon: { width: 28, alignItems: "center" },
  rowContent: { flex: 1 },
  rowLabel: { fontSize: 15, fontWeight: "500", color: "#0a0a0a" },
  rowLabelActive: { color: colors.accent },
  rowPath: { fontSize: 12, color: "#999999", marginTop: 1 },
})
