import { useCallback, useMemo, useState } from "react"
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View, Keyboard, useWindowDimensions } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useTranslation } from "react-i18next"
import { shouldCapSheetContent, sheetContentCap, SheetHandle } from "@web2bizz/ui-native"
import { filterMockRepos, type MockRepo } from "../../lib/github-mock"
import { useClonedProjects } from "../../stores/cloned-projects"
import { useConnections } from "../../stores/connections"

interface Props {
  // Parent-owned ref — the sheet is UNCONTROLLED (no `visible` prop): the
  // parent opens it imperatively via expand(), exactly like the folder
  // sheets and AiSettingsModal. No open/close state of its own.
  sheetRef: React.RefObject<BottomSheet | null>
  isDark: boolean
  // Optional base directory the repo is cloned into (defaults to
  // ~/projects inside the store). The current caller passes none.
  targetDir?: string
}

// GitHub clone flow as a bottom sheet (moved from the former
// app/project/clone.tsx Stack route): the same proven recipe as
// AiSettingsModal / the new-project sheet — BottomSheet + index -1 +
// imperative expand/close via a parent-owned ref, single 80% detent,
// memoized backdrop, BottomSheetFlatList + BottomSheetTextInput.
// Same mock 1.5s clone flow and store calls as the old route screen.
export function CloneRepoSheet({ sheetRef, isDark, targetDir }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState("")
  const [cloningId, setCloningId] = useState<string | null>(null)
  const addCloned = useClonedProjects((s) => s.addCloned)
  const addRecentDirectory = useConnections((s) => s.addRecentDirectory)

  const repos = useMemo(() => filterMockRepos(query), [query])

  // Wide-screen centered column so rows don't stretch across a tablet.
  const { width: winWidth } = useWindowDimensions()
  const capContent = shouldCapSheetContent(winWidth)

  // UI stub: fake 1.5s "cloning", then stores the project locally and
  // closes the sheet. Backend will replace the setTimeout with a real
  // clone call — the store shape stays.
  const onClone = useCallback(
    (id: string) => {
      if (cloningId) return
      const repo = repos.find((r) => r.id === id)
      if (!repo) return
      setCloningId(id)
      setTimeout(() => {
        const project = addCloned(repo, typeof targetDir === "string" ? targetDir : undefined)
        void addRecentDirectory(project.path).catch(() => {})
        setCloningId(null)
        // Search field may hold focus — hide the keyboard with the sheet.
        Keyboard.dismiss()
        sheetRef.current?.close()
      }, 1500)
    },
    [cloningId, repos, addCloned, addRecentDirectory, targetDir, sheetRef],
  )

  // Single 80% detent: expand() targets the highest detent, so one detent
  // keeps the repo list at a fixed 80% height; the list scrolls inside.
  const snapPoints = useMemo(() => ["80%"], [])
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" opacity={0.5} />
    ),
    [],
  )

  const renderRepo = useCallback(
    ({ item }: { item: MockRepo }) => {
      const cloning = cloningId === item.id
      return (
        <TouchableOpacity
          style={[s.row, isDark && s.rowDark, capContent && sheetContentCap]}
          onPress={() => onClone(item.id)}
          disabled={cloningId !== null}
          testID={`repo-item-${item.id}`}
        >
          <Ionicons
            name={item.isPrivate ? "lock-closed-outline" : "logo-github"}
            size={20}
            color={isDark ? "#888888" : "#666666"}
          />
          <View style={s.rowContent}>
            <View style={s.nameRow}>
              <Text style={[s.rowName, isDark && s.textDark]} numberOfLines={1}>
                {item.fullName}
              </Text>
              {item.isPrivate && (
                <View style={s.privateBadge}>
                  <Text style={s.privateText}>{t("project.clone.private")}</Text>
                </View>
              )}
            </View>
            <Text style={[s.rowDesc, isDark && s.metaDark]} numberOfLines={2}>
              {item.description}
            </Text>
            <View style={s.metaRow}>
              <Text style={[s.metaText, isDark && s.metaDark]}>{item.language}</Text>
              <Text style={[s.metaText, isDark && s.metaDark]}>★ {item.stars}</Text>
              <Text style={[s.metaText, isDark && s.metaDark]}>{item.updatedAt}</Text>
            </View>
          </View>
          {cloning ? (
            <ActivityIndicator size="small" color={isDark ? "#ffffff" : "#0a0a0a"} testID="cloning-indicator" />
          ) : (
            <Ionicons name="download-outline" size={20} color={isDark ? "#8b5cf6" : "#6d28d9"} />
          )}
        </TouchableOpacity>
      )
    },
    [cloningId, isDark, onClone, t, capContent],
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
    >
      <View style={[s.titleRow, capContent && sheetContentCap]}>
        <Text style={[s.title, isDark && s.textWhite]}>{t("project.clone.title")}</Text>
      </View>
      {typeof targetDir === "string" && !!targetDir && (
        <View style={[s.targetWrap, capContent && sheetContentCap]}>
          <View style={[s.targetBox, isDark && s.targetBoxDark]} testID="clone-target-dir">
            <Ionicons name="folder-outline" size={14} color={isDark ? "#888888" : "#666666"} />
            <Text style={[s.targetText, isDark && s.metaDark]} numberOfLines={1}>
              {t("project.clone.targetLabel")}: {targetDir}
            </Text>
          </View>
        </View>
      )}
      <View style={[s.searchWrap, capContent && sheetContentCap]}>
        <BottomSheetTextInput
          style={[s.search, isDark && s.searchDark]}
          placeholder={t("project.clone.searchPlaceholder")}
          placeholderTextColor={isDark ? "#666666" : "#999999"}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          testID="clone-search-input"
        />
      </View>
      <BottomSheetFlatList
        data={repos}
        keyExtractor={(r: MockRepo) => r.id}
        renderItem={renderRepo}
        contentContainerStyle={s.list}
        ListEmptyComponent={
          <View style={[s.empty, capContent && sheetContentCap]}>
            <Text style={[s.emptyText, isDark && s.metaDark]}>{t("project.clone.empty")}</Text>
          </View>
        }
      />
    </BottomSheet>
  )
}

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
  targetWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  targetBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#f5f5f5",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  targetBoxDark: { backgroundColor: "#2a2a2a" },
  targetText: { flex: 1, fontSize: 12, color: "#666666" },
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#f5f5f5",
    padding: 14,
    borderRadius: 10,
    marginBottom: 6,
  },
  rowDark: { backgroundColor: "#2a2a2a" },
  rowContent: { flex: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { fontSize: 14, fontWeight: "600", color: "#0a0a0a", flex: 1 },
  rowDesc: { fontSize: 13, color: "#666666", marginTop: 2 },
  metaRow: { flexDirection: "row", gap: 12, marginTop: 4 },
  metaText: { fontSize: 12, color: "#999999" },
  privateBadge: { backgroundColor: "#fef3c7", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  privateText: { fontSize: 10, fontWeight: "700", color: "#92400e" },
  textDark: { color: "#ffffff" },
  metaDark: { color: "#888888" },
  empty: { paddingVertical: 32, alignItems: "center" },
  emptyText: { fontSize: 14, color: "#666666" },
})
