import { useMemo, useState } from "react"
import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { BottomSheetFlatList, BottomSheetTextInput } from "@gorhom/bottom-sheet"
import { Ionicons } from "@expo/vector-icons"
import { colors } from "../../theme"

export interface SelectOption {
  id: string | null
  label: string
  description?: string
  dotColor?: string
  group?: string
}

interface Props {
  label: string
  options: SelectOption[]
  selectedId: string | null
  isDark: boolean
  onSelect: (id: string | null) => void
  testID?: string
  searchPlaceholder?: string
}

// Custom dropdown in app theme: bordered box, collapsible option list,
// checkmark on the selected value. Expands inline (accordion) so it works
// inside any dialog without nested modals. Uses the bottom-sheet gesture
// variants so scrolling/search keep working inside a BottomSheetModal.
export function Select({ label, options, selectedId, isDark, onSelect, testID, searchPlaceholder }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const selected = options.find((o) => o.id === selectedId)

  const q = query.trim().toLowerCase()
  const visibleOptions = !searchPlaceholder || !q
    ? options
    : options.filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          (o.description || "").toLowerCase().includes(q) ||
          (o.group || "").toLowerCase().includes(q),
      )

  // Flatten options with group headers into virtualized rows so long lists
  // (hundreds of models) render only the visible window, like every other
  // list in the app (FlatList in messages/projects/tasks, BottomSheetFlatList
  // in the directory browser).
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
  }, [visibleOptions])

  const toggle = () => {
    setExpanded((v) => !v)
    setQuery("")
  }

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === "header") {
      return <Text style={[s.groupTitle, isDark && s.metaDark]}>{item.title}</Text>
    }
    const o = item.option
    const active = o.id === selectedId
    return (
      <TouchableOpacity
        style={[s.row, isDark && s.rowDark, active && (isDark ? s.rowSelectedDark : s.rowSelected)]}
        onPress={() => {
          onSelect(o.id)
          setExpanded(false)
          setQuery("")
        }}
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
  }

  return (
    <View style={[s.box, isDark && s.boxDark]} testID={testID}>
      <TouchableOpacity style={s.header} onPress={toggle} activeOpacity={0.7}>
        <View style={s.headerText}>
          <Text style={[s.label, isDark && s.metaDark]}>{label}</Text>
          <Text style={[s.value, isDark && s.textWhite]} numberOfLines={1}>
            {selected ? selected.label : "—"}
          </Text>
        </View>
        <Ionicons
          name={expanded ? "chevron-up-outline" : "chevron-down-outline"}
          size={18}
          color={isDark ? colors.textSecondaryDark : colors.textSecondaryLight}
        />
      </TouchableOpacity>

      {expanded && (
        <View style={s.list}>
          {!!searchPlaceholder && (
            <BottomSheetTextInput
              style={[s.search, isDark && s.searchDark]}
              placeholder={searchPlaceholder}
              placeholderTextColor={isDark ? colors.textTertiaryDark : colors.textTertiaryLight}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              autoCapitalize="none"
            />
          )}
          <BottomSheetFlatList
            style={s.optionsScroll}
            data={rows}
            keyExtractor={(item: Row) => item.key}
            renderItem={renderRow}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={rows.length > 8}
            initialNumToRender={12}
            windowSize={5}
            removeClippedSubviews
          />
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  box: {
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  // NOTE: #3a3a3a has no theme token (borderDark is #1a1a1a) — kept as-is.
  boxDark: { backgroundColor: colors.surfaceDark2, borderColor: "#3a3a3a" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    gap: 8,
  },
  headerText: { flex: 1, gap: 2 },
  label: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textTertiaryLight,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  value: { fontSize: 15, fontWeight: "600", color: colors.textPrimaryLight },
  textWhite: { color: colors.textPrimaryDark },
  metaDark: { color: colors.textSecondaryDark },
  list: { paddingBottom: 8, gap: 2 },
  // Cap for long option lists (≈6 rows): the list scrolls internally instead
  // of growing the dialog unbounded. nestedScrollEnabled lets the inner scroll
  // win over the dialog's outer ScrollView on Android.
  optionsScroll: { maxHeight: 300 },
  search: {
    backgroundColor: colors.white,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.textPrimaryLight,
    marginBottom: 6,
  },
  searchDark: { backgroundColor: colors.surfaceDark, color: colors.textPrimaryDark },
  groupTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textTertiaryLight,
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
  rowName: { fontSize: 15, fontWeight: "500", color: colors.textPrimaryLight },
  rowDesc: { fontSize: 12, color: colors.textTertiaryLight, marginTop: 1 },
})
