import { useCallback, useMemo, useRef, useState } from "react"
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View, Keyboard, useWindowDimensions } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useTranslation } from "react-i18next"
import type { DirectoryClient, FileEntry } from "../../types"
import { parentOf, nameOf, breadcrumbsOf } from "../../utils/path-utils"
import { normalizeRoots, type FileRoot } from "../../utils/file-roots"
import { colors } from "../../theme"
import { shouldCapSheetContent, sheetContentCap } from "../../utils/sheet-layout"
import { MOCK_HOME, MOCK_ROOTS, listMockDir } from "../../utils/fs-mock"
import { SheetHandle } from "./SheetHandle"

// Fake latency so the mock mode feels like the real API during UI review.
const MOCK_DELAY_MS = 350

interface Props {
  sheetRef: React.RefObject<BottomSheet | null>
  // Directory to start browsing from whenever the sheet opens (project root, server home, etc).
  // When null, the sheet resolves the server home itself so the user never
  // has to type a path manually.
  startDirectory: string | null
  // Builds a client rooted at an arbitrary absolute directory (see connections store).
  // Called with undefined to get a directory-less client (server home lookup).
  // Ignored when useMock is set.
  clientForDirectory: (directory?: string) => DirectoryClient | null
  isDark: boolean
  // Called with the chosen absolute directory when the user taps "Use this folder".
  onSelect: (directory: string) => void
  // Called whenever the sheet fully closes (selection or cancel).
  onDismiss?: () => void
  // UI stub: browse the static mock tree (fs-mock.ts) instead of the server.
  // Shapes mirror the real devbox API; drop this prop when backend lands.
  useMock?: boolean
}

export function DirectoryBrowserSheet({
  sheetRef,
  startDirectory,
  clientForDirectory,
  isDark,
  onSelect,
  onDismiss,
  useMock,
}: Props) {
  const { t } = useTranslation()
  const [browseDir, setBrowseDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jumpPath, setJumpPath] = useState("")
  // Manual path entry is a fallback — the explorer (roots + breadcrumbs +
  // folder list) is the primary way, so the input stays collapsed.
  const [showJump, setShowJump] = useState(false)
  // Pinned top-level entries (drives, home dir) fetched from GET /file/roots.
  // Stays empty on older servers that don't expose the endpoint, or while a
  // fetch is in flight — the manual "Jump to path" input keeps working
  // either way.
  const [roots, setRoots] = useState<FileRoot[]>([])
  const loadToken = useRef(0)

  const load = useCallback(
    (dir: string) => {
      const token = ++loadToken.current
      setLoading(true)
      setError(null)
      if (useMock) {
        setTimeout(() => {
          if (loadToken.current !== token) return
          setEntries(listMockDir(dir))
          setLoading(false)
        }, MOCK_DELAY_MS)
        return
      }
      const client = clientForDirectory(dir)
      if (!client) {
        setEntries([])
        setLoading(false)
        setError(t("chat.directoryBrowserSheet.noActiveConnection"))
        return
      }
      client.file
        .list({ path: "." })
        .then((items) => {
          if (loadToken.current !== token) return
          setEntries(items.filter((item) => item.type === "directory"))
        })
        .catch((err) => {
          if (loadToken.current !== token) return
          setEntries([])
          setError(err instanceof Error ? err.message : t("chat.directoryBrowserSheet.listFailed"))
        })
        .finally(() => {
          if (loadToken.current === token) setLoading(false)
        })
    },
    [clientForDirectory, t, useMock],
  )

  const enter = useCallback(
    (dir: string) => {
      setBrowseDir(dir)
      load(dir)
    },
    [load],
  )

  // Fetch pinned filesystem roots for the current server. Silently falls
  // back to no pinned roots (manual path entry still works) on older
  // servers or any request failure.
  const loadRoots = useCallback(
    (dir: string) => {
      if (useMock) {
        setRoots(MOCK_ROOTS)
        return
      }
      const client = clientForDirectory(dir)
      if (!client) {
        setRoots([])
        return
      }
      client.file
        .roots()
        .then((result) => setRoots(normalizeRoots(result)))
        .catch(() => setRoots([]))
    },
    [clientForDirectory, useMock],
  )

  // Resolve the server home directory so the explorer opens usable even
  // when the caller doesn't know a start directory (no manual typing needed).
  const loadHome = useCallback(() => {
    if (useMock) {
      enter(MOCK_HOME)
      loadRoots(MOCK_HOME)
      return
    }
    const client = clientForDirectory(undefined)
    if (!client) {
      loadToken.current++
      setBrowseDir(null)
      setEntries([])
      setError(t("chat.directoryBrowserSheet.noActiveConnection"))
      setLoading(false)
      setRoots([])
      return
    }
    const token = ++loadToken.current
    setLoading(true)
    setError(null)
    client.path
      .get()
      .then((paths) => {
        if (loadToken.current !== token) return
        enter(paths.home)
        loadRoots(paths.home)
      })
      .catch(() => {
        if (loadToken.current !== token) return
        setLoading(false)
        setBrowseDir(null)
        setEntries([])
        setRoots([])
      })
  }, [clientForDirectory, enter, loadRoots, t, useMock])

  // The caller sets the start directory via setState and calls
  // sheetRef.current?.expand() in the very same synchronous handler.
  // synchronous handler. expand() kicks off a reanimated-driven animation
  // whose onChange callback can fire before React has committed the
  // re-render that would give this component the new `startDirectory` prop
  // (issue #104: this raced consistently, leaving the sheet permanently
  // showing "Enter a path above to start browsing" because the FIRST
  // onChange(index=0) captured `startDirectory=null` from the initial
  // mount's closure and set wasOpen=true, which then blocked every later
  // onChange from ever calling enter() again for that open). Mirror the
  // prop into a ref, updated inline on every render (synchronous, no extra
  // render cycle) so the onChange handler below always reads the latest
  // value regardless of which render's closure the native side invokes.
  const startDirectoryRef = useRef(startDirectory)
  startDirectoryRef.current = startDirectory

  // Reset to the starting directory when the sheet transitions from closed
  // to open (not on drags between snap points), and notify on full close.
  const wasOpen = useRef(false)
  const handleSheetChange = useCallback(
    (index: number) => {
      if (index < 0) {
        wasOpen.current = false
        onDismiss?.()
        return
      }
      if (wasOpen.current) return // snap-point change while already open
      wasOpen.current = true
      setJumpPath("")
      setShowJump(false)
      const dir = startDirectoryRef.current
      if (dir) {
        enter(dir)
        loadRoots(dir)
      } else {
        // No starting directory known — resolve the server home so the
        // explorer is usable without typing a path manually.
        loadHome()
      }
    },
    [enter, loadRoots, loadHome, onDismiss],
  )

  const goUp = useCallback(() => {
    if (!browseDir) return
    const parent = parentOf(browseDir)
    if (!parent) return
    enter(parent)
  }, [browseDir, enter])

  const goJump = useCallback(() => {
    const dir = jumpPath.trim()
    if (!dir) return
    Keyboard.dismiss()
    setJumpPath("")
    enter(dir)
  }, [jumpPath, enter])

  const handleUseFolder = useCallback(() => {
    if (!browseDir) return
    // Jump-to-path field may hold focus — hide the keyboard so it doesn't
    // linger over the closing sheet.
    Keyboard.dismiss()
    onSelect(browseDir)
    sheetRef.current?.close()
  }, [browseDir, onSelect, sheetRef])

  const canGoUp = !!browseDir && !!parentOf(browseDir)

  // Wide-screen centered column so rows don't stretch across a tablet.
  // Detent stays 80% — tall enough in landscape as is.
  const { width: winWidth } = useWindowDimensions()
  const capContent = shouldCapSheetContent(winWidth)

  // Single 80% detent: expand() targets the highest detent, so one detent
  // keeps the explorer at a fixed 80% height. Memoized (like
  // DirectorySwitcher) because fresh literals on every render remount the
  // backdrop and can interrupt an in-progress drag.
  const snapPoints = useMemo(() => ["80%"], [])
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
      // Static percentage snapPoints are provided above, but @gorhom/bottom-sheet
      // v5 defaults enableDynamicSizing to true, which requires content wrapped
      // in a size-reporting component (BottomSheetView) to ever compute a valid
      // detent — this sheet's children are plain Views/BottomSheetFlatList, so
      // contentHeight never resolves and the sheet can never open (expand() has
      // no valid snap position to animate to). Disable dynamic sizing so the
      // explicit snapPoints above are used directly. See GitHub issue #104.
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
      onChange={handleSheetChange}
    >
      <View style={[s.header, capContent && sheetContentCap]}>
        <View style={s.titleRow}>
          <Text style={[s.title, isDark && s.white]}>{t("chat.directoryBrowserSheet.title")}</Text>
          {useMock && (
            <View style={s.mockBadge} testID="directory-mock-badge">
              <Text style={s.mockBadgeText}>{t("chat.directoryBrowserSheet.mockBadge")}</Text>
            </View>
          )}
        </View>
        <View style={s.pathRow}>
          <TouchableOpacity onPress={goUp} disabled={!canGoUp} hitSlop={8} testID="directory-up-button">
            <Ionicons
              name="arrow-up-circle-outline"
              size={22}
              color={canGoUp ? (isDark ? colors.accentPale : colors.accentStrong) : isDark ? "#3a3a3a" : "#dddddd"}
            />
          </TouchableOpacity>
          <Text style={[s.path, isDark && s.dimDark]} numberOfLines={1} ellipsizeMode="head">
            {browseDir || "…"}
          </Text>
        </View>
        {browseDir && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.crumbs}
            testID="directory-breadcrumbs"
          >
            {breadcrumbsOf(browseDir).map((crumb, i, all) => {
              const active = i === all.length - 1
              return (
                <View key={crumb.path} style={s.crumbWrap}>
                  {i > 0 && (
                    <Text style={[s.crumbSep, isDark && s.dimDark]}>/</Text>
                  )}
                  <TouchableOpacity
                    style={[s.crumb, active && s.crumbActive]}
                    onPress={() => !active && enter(crumb.path)}
                    disabled={active}
                    testID={`directory-crumb-${i}`}
                  >
                    <Text
                      style={[s.crumbText, isDark && s.crumbTextDark, active && s.crumbTextActive]}
                      numberOfLines={1}
                    >
                      {crumb.label === "/" ? t("chat.directoryBrowserSheet.rootLabel") : crumb.label}
                    </Text>
                  </TouchableOpacity>
                </View>
              )
            })}
          </ScrollView>
        )}
      </View>

      {roots.length > 0 && (
        <View style={s.rootsRow}>
          {roots.map((root) => (
            <TouchableOpacity
              key={root.path}
              style={[s.rootChip, isDark && s.rootChipDark, browseDir === root.path && s.rootChipActive]}
              onPress={() => enter(root.path)}
              testID={`directory-root-${root.label}`}
            >
              <Ionicons
                name={root.label === "Home" ? "home-outline" : "layers-outline"}
                size={14}
                color={browseDir === root.path ? "#ffffff" : isDark ? colors.accentExtraPale : colors.accentStrong}
              />
              <Text
                style={[
                  s.rootChipText,
                  isDark && s.rootChipTextDark,
                  browseDir === root.path && s.rootChipTextActive,
                ]}
                numberOfLines={1}
              >
                {root.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <TouchableOpacity
        style={s.manualToggle}
        onPress={() => setShowJump((v) => !v)}
        testID="directory-manual-toggle"
      >
        <Ionicons
          name={showJump ? "chevron-down" : "chevron-forward"}
          size={14}
          color={isDark ? "#888888" : "#666666"}
        />
        <Text style={[s.manualToggleText, isDark && s.dimDark]}>
          {t("chat.directoryBrowserSheet.manualToggle")}
        </Text>
      </TouchableOpacity>

      {showJump && (
        <View style={s.inputWrap}>
          <BottomSheetTextInput
            style={[s.input, isDark && s.inputDark]}
            placeholder={t("chat.directoryBrowserSheet.jumpPlaceholder")}
            placeholderTextColor={isDark ? "#666666" : "#999999"}
            value={jumpPath}
            onChangeText={setJumpPath}
            onSubmitEditing={goJump}
            returnKeyType="go"
            autoCapitalize="none"
            autoCorrect={false}
            testID="directory-jump-input"
          />
          {jumpPath.trim() && (
            <TouchableOpacity style={[s.goBtn, isDark && s.goBtnDark]} onPress={goJump}>
              <Ionicons name="arrow-forward" size={18} color={isDark ? "#0a0a0a" : "#ffffff"} />
            </TouchableOpacity>
          )}
        </View>
      )}

      <BottomSheetFlatList
        data={entries}
        keyExtractor={(item: FileEntry) => item.absolute}
        renderItem={({ item }: { item: FileEntry }) => (
          <TouchableOpacity
            style={[s.row, isDark && s.rowDark, capContent && sheetContentCap]}
            onPress={() => enter(item.absolute)}
            testID={`directory-row-${item.name}`}
          >
            <Ionicons
              name="folder-outline"
              size={20}
              color={item.ignored ? (isDark ? "#555555" : "#bbbbbb") : isDark ? "#888888" : "#666666"}
            />
            <Text style={[s.rowLabel, isDark && s.white, item.ignored && s.rowLabelDim]} numberOfLines={1}>
              {item.name}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={isDark ? "#555555" : "#cccccc"} />
          </TouchableOpacity>
        )}
        contentContainerStyle={s.list}
        ListHeaderComponent={
          loading ? (
            <View style={[s.centerBox, capContent && sheetContentCap]}>
              <ActivityIndicator color={isDark ? "#ffffff" : "#0a0a0a"} />
            </View>
          ) : error ? (
            <View style={[s.centerBox, capContent && sheetContentCap]}>
              <Text style={s.errorText}>{error}</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          !loading && !error ? (
            <Text style={[s.emptyText, isDark && s.dimDark, capContent && sheetContentCap]}>
              {browseDir
                ? t("chat.directoryBrowserSheet.noSubfolders")
                : t("chat.directoryBrowserSheet.enterPathHint")}
            </Text>
          ) : null
        }
      />

      <View style={[s.footer, capContent && sheetContentCap]}>
        <TouchableOpacity
          style={[s.selectBtn, isDark && s.selectBtnDark, !browseDir && s.selectBtnDisabled]}
          onPress={handleUseFolder}
          disabled={!browseDir}
          testID="directory-select-button"
        >
          <Ionicons name="checkmark-circle" size={18} color={isDark ? "#0a0a0a" : "#ffffff"} />
          <Text style={[s.selectBtnText, isDark && s.selectBtnTextDark]} numberOfLines={1}>
            {t("chat.directoryBrowserSheet.useFolderButton", {
              folder: browseDir ? nameOf(browseDir) : t("chat.directoryBrowserSheet.thisFolderFallback"),
            })}
          </Text>
        </TouchableOpacity>
      </View>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  sheet: { backgroundColor: "#ffffff" },
  sheetDark: { backgroundColor: "#1a1a1a" },
  header: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 18, fontWeight: "700", color: "#0a0a0a" },
  mockBadge: { backgroundColor: "#f59e0b", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  mockBadgeText: { color: "#ffffff", fontSize: 11, fontWeight: "700" },
  white: { color: "#ffffff" },
  pathRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  path: {
    flex: 1,
    fontSize: 12,
    color: "#666666",
  },
  dimDark: { color: "#888888" },
  crumbs: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
  },
  crumbWrap: {
    flexDirection: "row",
    alignItems: "center",
  },
  crumbSep: {
    fontSize: 13,
    color: "#999999",
    marginHorizontal: 2,
  },
  crumb: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    // Transparent: crumbs are theme-colored text links, not filled pills.
    backgroundColor: "transparent",
    maxWidth: 140,
  },
  crumbActive: {
    // Transparent like the idle crumb — the active state is carried by the
    // accent text color below, not a filled background.
    backgroundColor: "transparent",
  },
  crumbText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#444444",
  },
  // Dark-mode secondary text (matches dimDark) — a neutral gray so the
  // accent-colored active crumb stands out by hue on both themes.
  crumbTextDark: { color: "#888888" },
  crumbTextActive: { color: colors.accent },
  manualToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  manualToggleText: {
    fontSize: 12,
    color: "#666666",
  },
  rootsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  rootChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: colors.accentChipBg,
  },
  rootChipDark: { backgroundColor: colors.accentChipBgDark },
  rootChipActive: { backgroundColor: colors.accent },
  rootChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.accentStrong,
  },
  rootChipTextDark: { color: colors.accentExtraPale },
  rootChipTextActive: { color: "#ffffff" },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  input: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: "#f5f5f5",
    color: "#0a0a0a",
    fontSize: 14,
  },
  inputDark: {
    backgroundColor: "#2a2a2a",
    color: "#ffffff",
  },
  goBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: "#0a0a0a",
    alignItems: "center",
    justifyContent: "center",
  },
  goBtnDark: { backgroundColor: "#ffffff" },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: "#f5f5f5",
    marginBottom: 6,
  },
  rowDark: { backgroundColor: "#2a2a2a" },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  rowLabelDim: { color: "#999999" },
  centerBox: {
    paddingVertical: 24,
    alignItems: "center",
  },
  errorText: {
    fontSize: 13,
    color: "#ef4444",
    textAlign: "center",
    paddingHorizontal: 16,
  },
  emptyText: {
    fontSize: 13,
    color: "#999999",
    textAlign: "center",
    paddingVertical: 24,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e5e5",
  },
  selectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 46,
    borderRadius: 12,
    backgroundColor: "#0a0a0a",
  },
  selectBtnDark: { backgroundColor: "#ffffff" },
  selectBtnDisabled: { opacity: 0.5 },
  selectBtnText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ffffff",
  },
  selectBtnTextDark: { color: "#0a0a0a" },
})
