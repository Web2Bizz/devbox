import { useCallback, useMemo, useState } from "react"
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from "react-native"
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

// One queued follow-up prompt waiting for the session to go idle.
export interface QueuedItem {
  id: string
  text: string
}

interface Props {
  // Parent-owned ref — UNCONTROLLED sheet opened imperatively via expand(),
  // same recipe as AiSettingsModal/PickerSheet (index -1, no visible prop).
  sheetRef: React.RefObject<BottomSheet | null>
  items: QueuedItem[]
  isDark: boolean
  onRemove: (id: string) => void
  onUpdate: (id: string, text: string) => void
  snapPoints?: string[]
  testID?: string
}

// Bottom sheet listing the queued follow-ups in send order. Each row shows
// the text clipped to two lines with delete + edit buttons on the right;
// edit turns that row into an inline editor (save/cancel).
export function MessageQueueSheet({
  sheetRef,
  items,
  isDark,
  onRemove,
  onUpdate,
  snapPoints = DEFAULT_SNAP_POINTS,
  testID,
}: Props) {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  const { width: winWidth } = useWindowDimensions()
  const capContent = shouldCapSheetContent(winWidth)

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" opacity={0.5} />
    ),
    [],
  )

  const startEdit = useCallback((item: QueuedItem) => {
    setEditingId(item.id)
    setDraft(item.text)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setDraft("")
  }, [])

  const saveEdit = useCallback(
    (id: string) => {
      const text = draft.trim()
      if (text) onUpdate(id, text)
      setEditingId(null)
      setDraft("")
    },
    [draft, onUpdate],
  )

  const data = useMemo(() => items, [items])

  const renderItem = useCallback(
    ({ item, index }: { item: QueuedItem; index: number }) => {
      const editing = editingId === item.id
      return (
        <View style={[r.row, isDark && r.rowDark]} testID={testID ? `${testID}-row-${index}` : undefined}>
          <View style={r.textWrap}>
            <Text style={[r.index, isDark && r.metaDark]}>{index + 1}</Text>
            {editing ? (
              <BottomSheetTextInput
                style={[r.editor, isDark && r.editorDark]}
                value={draft}
                onChangeText={setDraft}
                multiline
                autoFocus
                testID={testID ? `${testID}-editor` : undefined}
              />
            ) : (
              <Text style={[r.text, isDark && r.textWhite]} numberOfLines={2} ellipsizeMode="tail">
                {item.text}
              </Text>
            )}
          </View>
          <View style={r.actions}>
            {editing ? (
              <>
                <TouchableOpacity
                  style={r.iconBtn}
                  onPress={cancelEdit}
                  hitSlop={8}
                  accessibilityLabel={t("common.cancel")}
                  testID={testID ? `${testID}-cancel` : undefined}
                >
                  <Ionicons name="close-outline" size={22} color={isDark ? "#888888" : "#666666"} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={r.iconBtn}
                  onPress={() => saveEdit(item.id)}
                  hitSlop={8}
                  accessibilityLabel={t("common.save")}
                  testID={testID ? `${testID}-save` : undefined}
                >
                  <Ionicons name="checkmark-outline" size={22} color={colors.accent} />
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={r.iconBtn}
                  onPress={() => startEdit(item)}
                  hitSlop={8}
                  accessibilityLabel={t("session.queue.edit")}
                  testID={testID ? `${testID}-edit` : undefined}
                >
                  <Ionicons name="pencil-outline" size={20} color={isDark ? "#888888" : "#666666"} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={r.iconBtn}
                  onPress={() => onRemove(item.id)}
                  hitSlop={8}
                  accessibilityLabel={t("session.queue.remove")}
                  testID={testID ? `${testID}-remove` : undefined}
                >
                  <Ionicons name="trash-outline" size={20} color="#ef4444" />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      )
    },
    [cancelEdit, draft, editingId, isDark, onRemove, saveEdit, startEdit, t, testID],
  )

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose
      enableHandlePanningGesture
      handleComponent={SheetHandle}
      backdropComponent={renderBackdrop}
      backgroundStyle={[s.sheet, isDark && s.sheetDark]}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <View style={[s.titleRow, capContent && sheetContentCap]}>
        <Text style={[s.title, isDark && s.textWhite]}>{t("session.queue.title")}</Text>
      </View>
      <BottomSheetFlatList
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={s.content}
        ListEmptyComponent={
          <Text style={[s.empty, isDark && s.metaDark]}>{t("session.queue.empty")}</Text>
        }
      />
    </BottomSheet>
  )
}

const DEFAULT_SNAP_POINTS = ["60%"]

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
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  empty: { fontSize: 14, color: "#999999", textAlign: "center", paddingVertical: 24 },
})

const r = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  rowDark: { backgroundColor: colors.surfaceDark2, borderColor: "#3a3a3a" },
  textWrap: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 8 },
  index: { fontSize: 13, fontWeight: "700", color: "#999999", minWidth: 18, paddingTop: 1 },
  text: { flex: 1, fontSize: 14, color: "#0a0a0a", lineHeight: 20 },
  textWhite: { color: "#ffffff" },
  metaDark: { color: "#888888" },
  editor: {
    flex: 1,
    fontSize: 14,
    color: "#0a0a0a",
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 40,
  },
  editorDark: { color: "#ffffff", borderColor: "#3a3a3a", backgroundColor: "#0a0a0a" },
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  iconBtn: { padding: 6 },
})
