import { useCallback, useMemo, useState } from "react"
import { View, Text, TouchableOpacity, StyleSheet, Keyboard, useWindowDimensions } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { colors } from "../../theme"
import { shouldCapSheetContent, sheetContentCap } from "../../utils/sheet-layout"
import { SheetHandle } from "./SheetHandle"
import type { SelectOption } from "./Select"

interface Props {
  // Parent-owned ref — the sheet is UNCONTROLLED (no `visible` prop): the
  // caller opens it imperatively via expand(), exactly like the folder
  // sheets and AiSettingsModal. No open/close state of its own.
  sheetRef: React.RefObject<BottomSheet | null>
  title: string
  options: SelectOption[]
  selectedId: string | null
  isDark: boolean
  onSelect: (id: string | null) => void
  // When set, a search field filters the list (long lists like models).
  searchPlaceholder?: string
  // Single detent the sheet opens at. Memoize at the call site when dynamic.
  snapPoints?: string[]
  testID?: string
}

// Generic single-choice bottom sheet: a titled list of options with an
// optional search field, the same proven recipe as the other sheets
// (BottomSheet + index -1 + imperative expand/close via a parent-owned
// ref). Used by AiSettingsModal for the agent and model pickers — the
// inline Select accordions are kept only for short lists (effort).
export function PickerSheet({
  sheetRef,
  title,
  options,
  selectedId,
  isDark,
  onSelect,
  searchPlaceholder,
  snapPoints = DEFAULT_SNAP_POINTS,
  testID,
}: Props) {
  const [query, setQuery] = useState("")

  // Wide-screen centered column so rows don't stretch across a tablet.
  const { width: winWidth } = useWindowDimensions()
  const capContent = shouldCapSheetContent(winWidth)

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" opacity={0.5} />
    ),
    [],
  )

  const q = query.trim().toLowerCase()
  const visibleOptions =
    !searchPlaceholder || !q
      ? options
      : options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            (o.description || "").toLowerCase().includes(q) ||
            (o.group || "").toLowerCase().includes(q),
        )

  // Flatten options with group headers into virtualized rows so long lists
  // (hundreds of models) render only the visible window.
  type Row = { kind: "header"; key: string; title: string } | { kind: "option"; key: string; option: SelectOption }
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    let lastGroup: string | undefined
    for (const o of visibleOptions) {
      if (o.group && o.group !== lastGroup) {
        lastGroup = o.group
        out.push({ kind: "header", key: `header:${o.group}`, title: o.group })
      }
      out.push({ kind: "option", key: `option:${o.id ?? "auto"}`, option: o })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleOptions])

  const handleSelect = useCallback(
    (id: string | null) => {
      // Search field may hold focus — hide the keyboard with the sheet.
      Keyboard.dismiss()
      onSelect(id)
      setQuery("")
      sheetRef.current?.close()
    },
    [onSelect, sheetRef],
  )

  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === "header") {
        return <Text style={[s.groupTitle, isDark && s.metaDark]}>{item.title}</Text>
      }
      const o = item.option
      const active = o.id === selectedId
      return (
        <TouchableOpacity
          style={[s.row, isDark && s.rowDark, active && (isDark ? s.rowSelectedDark : s.rowSelected)]}
          onPress={() => handleSelect(o.id)}
          testID={testID ? `${testID}-option-${o.id ?? "auto"}` : undefined}
        >
          {!!o.dotColor && <View style={[s.dot, { backgroundColor: o.dotColor }]} />}
          <View style={s.rowText}>
            <Text style={[s.rowName, isDark && s.textWhite]} numberOfLines={1}>
              {o.label}
            </Text>
            {!!o.description && (
              <Text style={[s.rowDesc, isDark && s.metaDark]} numberOfLines={1}>
                {o.description}
              </Text>
            )}
          </View>
          {active && <Ionicons name="checkmark-circle" size={20} color={colors.accent} />}
        </TouchableOpacity>
      )
    },
    [handleSelect, isDark, selectedId, testID],
  )

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose
      // Explicit (true by default): the handle pill must stay draggable.
      enableHandlePanningGesture
      handleComponent={SheetHandle}
      backdropComponent={renderBackdrop}
      backgroundStyle={[s.sheet, isDark && s.sheetDark]}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onChange={(idx) => {
        if (idx === -1) setQuery("")
      }}
    >
      <View style={[s.titleRow, capContent && sheetContentCap]}>
        <Text style={[s.title, isDark && s.textWhite]}>{title}</Text>
      </View>
      {!!searchPlaceholder && (
        <View style={[s.searchWrap, capContent && sheetContentCap]}>
          <BottomSheetTextInput
            style={[s.search, isDark && s.searchDark]}
            placeholder={searchPlaceholder}
            placeholderTextColor={isDark ? "#666666" : "#999999"}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            testID={testID ? `${testID}-search` : undefined}
          />
        </View>
      )}
      <BottomSheetFlatList
        data={rows}
        keyExtractor={(item: Row) => item.key}
        renderItem={renderRow}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[s.list, capContent && sheetContentCap]}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={[s.emptyText, isDark && s.metaDark]}>—</Text>
          </View>
        }
      />
    </BottomSheet>
  )
}

const DEFAULT_SNAP_POINTS = ["70%"]

const s = StyleSheet.create({
  sheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  sheetDark: { backgroundColor: "#1a1a1a" },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: { fontSize: 18, fontWeight: "700", color: "#0a0a0a" },
  textWhite: { color: "#ffffff" },
  metaDark: { color: "#888888" },
  searchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  search: {
    backgroundColor: "#f5f5f5",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    color: "#0a0a0a",
  },
  searchDark: { backgroundColor: "#2a2a2a", color: "#ffffff" },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  groupTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#999999",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingTop: 8,
    paddingBottom: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  rowDark: {},
  rowSelected: { backgroundColor: colors.accentMuted },
  rowSelectedDark: { backgroundColor: colors.accentMutedDark },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: "500", color: "#0a0a0a" },
  rowDesc: { fontSize: 12, color: "#999999", marginTop: 1 },
  empty: { paddingVertical: 32, alignItems: "center" },
  emptyText: { fontSize: 14, color: "#666666" },
})
