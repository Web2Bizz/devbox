import { useCallback, useEffect, useMemo, useState, useRef } from "react"
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  useColorScheme,
  useWindowDimensions,
  RefreshControl,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Linking,
} from "react-native"
import { router } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { useSessionsList, useCreateSession, useDeleteSession, useRenameSession } from "../../src/queries/sessions"
import { useProjectInfo, useServerProjects } from "../../src/queries/project"
import { useConnections } from "../../src/stores/connections"
import { useEvents } from "../../src/stores/events"
import { useSettings } from "../../src/stores/settings"
import { LanDiscoveryModal } from "@web2bizz/ui-native"
import type { LanCandidate } from "@web2bizz/ui-native"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import type { Project } from "../../src/lib/sdk"
import { DirectorySwitcher, DirectoryBrowserSheet } from "@web2bizz/ui-native"
import { CloneRepoSheet } from "../../src/components/chat/CloneRepoSheet"
import { SheetHandle } from "@web2bizz/ui-native"
import { groupProjects } from "../../src/lib/session-grouping"
import { lanConnectionIds } from "../../src/lib/listed-session"
import type { ListedSession } from "../../src/lib/listed-session"
import { UpdateBanner } from "../../src/components/UpdateBanner"
import { nameOf } from "@web2bizz/ui-native"
import { useUi } from "../../src/stores/ui"
import { breakpoints, colors } from "@web2bizz/ui-native"
import { useTablet } from "@web2bizz/ui-native"
import { isLandscapeSize, shouldCapSheetContent, sheetContentCap } from "@web2bizz/ui-native"

function formatTime(timestamp: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 60000) return t("sessionsList.time.justNow")
  if (diff < 3600000) return t("sessionsList.time.minutesAgo", { count: Math.floor(diff / 60000) })
  if (diff < 86400000) return t("sessionsList.time.hoursAgo", { count: Math.floor(diff / 3600000) })
  if (diff < 604800000) return t("sessionsList.time.daysAgo", { count: Math.floor(diff / 86400000) })

  return date.toLocaleDateString()
}

function ProjectCard({
  directory,
  connectionId,
  isLocal,
  count,
  lastUpdated,
  isDark,
}: {
  directory: string
  connectionId: string
  isLocal: boolean
  count: number
  lastUpdated: number
  isDark: boolean
}) {
  const { t } = useTranslation()
  const shortName = directory.split("/").filter(Boolean).pop() || directory
  const onPress = () => {
    router.push({
      pathname: "/project/[directory]",
      params: { directory: encodeURIComponent(directory), connectionId },
    })
  }
  return (
    <TouchableOpacity
      style={[styles.projectCard, isDark && styles.projectCardDark]}
      onPress={onPress}
      testID={`project-card-${connectionId}-${directory}`}
    >
      <View style={styles.projectCardHeader}>
        <Ionicons name="folder" size={22} color={isDark ? colors.accentPale : colors.accentStrong} />
        <Text style={[styles.projectCardTitle, isDark && styles.textDark]} numberOfLines={1}>
          {shortName}
        </Text>
        {isLocal && (
          <View style={[styles.localBadge, isDark && styles.localBadgeDark]}>
            <Text style={[styles.localBadgeText, isDark && styles.localBadgeTextDark]}>
              {t("project.localBadge")}
            </Text>
          </View>
        )}
        <View style={[styles.countBadge, isDark && styles.countBadgeDark]}>
          <Text style={[styles.countBadgeText, isDark && styles.countBadgeTextDark]}>{count}</Text>
        </View>
      </View>
      <Text style={[styles.projectCardPath, isDark && styles.metaDark]} numberOfLines={1}>
        {directory}
      </Text>
      <Text style={[styles.projectCardMeta, isDark && styles.metaDark]}>
        {t("sessionsList.sessionsCount", { count })} · {formatTime(lastUpdated, t)}
      </Text>
    </TouchableOpacity>
  )
}

// Get short directory name (last folder or project name)
function getShortPath(
  project: { path?: { cwd?: string; root?: string; absolute?: string }; name?: string } | null | undefined,
): string {
  if (!project) return ""
  if (project.name) return project.name
  if (!project.path?.absolute) return ""
  const parts = project.path.absolute.split("/").filter(Boolean)
  return parts[parts.length - 1] || project.path.absolute
}

export default function SessionsScreen() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()
  const [showNewSession, setShowNewSession] = useState(false)
  const { showNewProject, closeNewProject } = useUi()
  // Источник списка проектов: основной сервер vs локальная сеть. Переключатель
  // живет только на этой странице (сегмент-контрол над таб-баром) и меняет
  // лишь список ниже — остальные табы не трогает.
  const [sourceTab, setSourceTab] = useState<"server" | "lan">("server")
  const [lanVisible, setLanVisible] = useState(false)
  const lanDiscovery = useSettings((s) => s.lanDiscovery)
  const setLanDiscovery = useSettings((s) => s.setLanDiscovery)
  const [isCreating, setIsCreating] = useState(false)
  const [renaming, setRenaming] = useState<ListedSession | null>(null)
  const [renameText, setRenameText] = useState("")
  const renamingInFlight = useRef(false)
  // Synchronous re-entrancy guard: `isCreating` state lags by a render, so a
  // fast double-tap on the FAB / "Use this folder" would fire two session
  // creates before the disabled state lands. This blocks the second call.
  const creatingInFlight = useRef(false)
  // Server snapshots from the React Query cache: auto-fetched when the client
  // appears, SSE-synced, refetched on foreground and on pull-to-refresh.
  // No imperative loadSessions()/refreshProject() calls anymore.
  const {
    data: sessionsData,
    isLoading,
    error: sessionsError,
    refetch: refetchSessions,
  } = useSessionsList()
  const sessions = sessionsData ?? []
  const { data: projectInfo, refetch: refetchProject } = useProjectInfo()
  const currentProject = projectInfo?.project ?? null
  const serverHome = projectInfo?.home ?? null
  // Server-known projects load while the new-session UI is open — plus on the
  // LAN tab, so a freshly connected LAN server shows something to start from
  // even with zero sessions yet.
  const { data: serverProjectsData, error: serverProjectsError } = useServerProjects(showNewSession || showNewProject || sourceTab === "lan")
  const serverProjects = serverProjectsData ?? []
  const createSession = useCreateSession()
  const deleteSession = useDeleteSession()
  const renameSession = useRenameSession()
  const {
    activeConnection,
    connections,
    clientBases,
    clientForDirectory,
    switchDirectory,
    recentDirectories,
    setActiveConnection,
  } = useConnections()
  const authError = useEvents((s) => s.authError)
  const reconnect = useEvents((s) => s.connect)
  const dirSheetRef = useRef<BottomSheet>(null)
  const browserSheetRef = useRef<BottomSheet>(null)
  // GitHub clone sheet (replaces the old /project/clone route screen):
  // parent-owned ref, opened imperatively via expand() — no visible-state
  // feedback loop, same as the other sheets on this screen.
  const cloneSheetRef = useRef<BottomSheet>(null)
  // New-project bottom sheet (replaces the old RN modal): driven by two
  // sources — local state (FAB long-press and friends) and the global UI
  // store (navbar tab). Imperative expand/close keeps it in sync with both.
  const newSheetRef = useRef<BottomSheet>(null)
  const newSheetOpen = showNewSession || showNewProject
  // Sheets must open AFTER the keyboard is gone: expanding while a field
  // holds focus (rename input, another sheet's search, or the chat composer
  // left open on another tab) leaves only the backdrop visible — the sheet
  // never measures against the keyboard-resized layout. Same recipe as the
  // AI settings sheet on the session screen: dismiss first, expand once
  // keyboardDidHide lands, fallback timer in case the event never comes.
  const sheetPendingRef = useRef(false)
  const sheetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sheetKbSubRef = useRef<{ remove: () => void } | null>(null)
  useEffect(
    () => () => {
      if (sheetTimerRef.current) clearTimeout(sheetTimerRef.current)
      sheetTimerRef.current = null
      sheetKbSubRef.current?.remove()
      sheetKbSubRef.current = null
      sheetPendingRef.current = false
    },
    [],
  )
  const expandSheet = useCallback((ref: React.RefObject<BottomSheet | null>) => {
    if (sheetPendingRef.current) return
    sheetPendingRef.current = true
    Keyboard.dismiss()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (sheetTimerRef.current) {
        clearTimeout(sheetTimerRef.current)
        sheetTimerRef.current = null
      }
      sheetKbSubRef.current?.remove()
      sheetKbSubRef.current = null
      sheetPendingRef.current = false
      ref.current?.expand()
    }
    const keyboardVisible = typeof Keyboard.isVisible === "function" ? Keyboard.isVisible() : true
    if (!keyboardVisible) {
      // Keyboard already hidden — expand on the next tick so the dismiss
      // commits before measuring.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(finish)
      } else {
        sheetTimerRef.current = setTimeout(finish, 0)
      }
      return
    }
    const sub = Keyboard.addListener("keyboardDidHide", finish)
    sheetKbSubRef.current = sub
    sheetTimerRef.current = setTimeout(finish, Platform.OS === "android" ? 150 : 100)
  }, [])
  useEffect(() => {
    if (newSheetOpen) expandSheet(newSheetRef)
    else newSheetRef.current?.close()
  }, [newSheetOpen, expandSheet])
  const closeNewSession = useCallback(() => {
    setShowNewSession(false)
    closeNewProject()
  }, [closeNewProject])
  // Single 50% detent in portrait; landscape gets 90%: 50% of a
  // landscape-height screen is too short to pick a project. Wide screens
  // also center the sheet body into a max-width column (see sheetContentCap).
  const { width: winWidth, height: winHeight } = useWindowDimensions()
  const sheetLandscape = isLandscapeSize(winWidth, winHeight)
  const capSheetContent = shouldCapSheetContent(winWidth)
  const newSheetSnapPoints = useMemo(() => [sheetLandscape ? "90%" : "50%"], [sheetLandscape])
  const renderNewSheetBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" opacity={0.5} />
    ),
    [],
  )
  const [browseStartDir, setBrowseStartDir] = useState<string | null>(null)
  // Shared folder browser is opened either to pick a directory for a new
  // session, or to switch the active connection's directory.
  const [browseMode, setBrowseMode] = useState<"create" | "switch">("create")
  const [refreshing, setRefreshing] = useState(false)
  const { numColumns, width: windowWidth } = useTablet()
  const isWide = windowWidth >= breakpoints.desktop
  // Directories collapsed in the grouped session list. Empty by default —
  // all groups start expanded (#67).
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())

  const toggleGroup = useCallback((directory: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(directory)) next.delete(directory)
      else next.add(directory)
      return next
    })
  }, [])

  // Projects = unique (connection, directory) pairs that have sessions, each
  // as a card. Same path on two servers is two cards; LAN cards carry the
  // (local) badge.
  const lanIds = useMemo(() => lanConnectionIds(connections), [connections])
  const lanConnections = useMemo(() => connections.filter((c) => c.discoveredOnLan), [connections])
  const projects = useMemo(() => {
    const groups = groupProjects(sessions)
    return groups
      .map((g) => ({
        key: g.key,
        directory: g.directory,
        connectionId: g.connectionId,
        isLocal: lanIds.has(g.connectionId),
        count: g.items.length,
        lastUpdated: Math.max(...g.items.map((s) => s.time.updated), 0),
      }))
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
  }, [sessions, lanIds])
  // Две независимые выборки для сегмент-табов: серверные и LAN-проекты.
  const serverProjectsList = useMemo(() => projects.filter((p) => !lanIds.has(p.connectionId)), [projects, lanIds])
  const lanProjectsList = useMemo(() => projects.filter((p) => lanIds.has(p.connectionId)), [projects, lanIds])

  // LAN: tap on "Find" is consent — enable discovery on the fly (same as login).
  const handleFindLan = useCallback(async () => {
    if (!lanDiscovery) await setLanDiscovery(true)
    setLanVisible(true)
  }, [lanDiscovery, setLanDiscovery])

  // LAN discovery pick: found server becomes a second connection entry (main
  // server untouched) and is activated so its projects load right away.
  const handlePickLan = useCallback(
    async (candidate: LanCandidate) => {
      const store = useConnections.getState()
      const existing = store.connections.find((c) => c.discoveredOnLan && c.url === candidate.url)
      const id = existing ? existing.id : await store.addLanConnection(candidate.url, `LAN · ${candidate.host}`)
      await store.setActiveConnection(id)
      setLanVisible(false)
    },
    [],
  )

  const handleUseLan = useCallback(
    (id: string) => {
      void setActiveConnection(id)
    },
    [setActiveConnection],
  )

  // LAN entry without credentials can't list anything — activate it and send
  // to login (local mode) to enter username/password.
  const handleLoginLan = useCallback(
    async (id: string) => {
      await setActiveConnection(id)
      router.push("/login")
    },
    [setActiveConnection],
  )

  const handleSwitchDirectory = useCallback(
    async (dir?: string) => {
      // switchDirectory swaps the client, which invalidates every
      // connection-scoped query (sessions, catalog, project info) — mounted
      // hooks refetch against the new client on their own.
      await switchDirectory(dir)
    },
    [switchDirectory],
  )

  const onRefresh = useCallback(async () => {
    // Без клиента refetch'ить нечего (projectInfo кинет "No active
    // connection") — тихо выходим, RefreshControl не дергаем.
    if (!useConnections.getState().client) return
    setRefreshing(true)
    try {
      await Promise.all([refetchSessions(), refetchProject()])
    } catch (err) {
      console.error("Refresh failed:", err)
    } finally {
      setRefreshing(false)
    }
  }, [refetchSessions, refetchProject])

  const handleRename = useCallback((session: ListedSession) => {
    setRenameText(session.title || "")
    setRenaming(session)
  }, [])

  const submitRename = useCallback(async () => {
    const title = renameText.trim()
    if (!title || !renaming || renamingInFlight.current) return
    renamingInFlight.current = true
    try {
      await renameSession.mutateAsync({ id: renaming.id, title, directory: renaming.directory, connectionId: renaming.connectionId })
      setRenaming(null)
      setRenameText("")
    } catch (err) {
      console.error("Rename failed:", err)
      Alert.alert(t("sessionsList.alerts.renameFailedTitle"), t("sessionsList.alerts.renameFailedMessage"))
    } finally {
      renamingInFlight.current = false
    }
  }, [renaming, renameText, renameSession, t])

  const handleDelete = useCallback(
    (session: ListedSession) => {
      Alert.alert(
        t("sessionsList.alerts.deleteTitle"),
        t("sessionsList.alerts.deleteMessage", { title: session.title || t("sessionsList.untitledSession") }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("common.delete"),
            style: "destructive",
            onPress: async () => {
              try {
                await deleteSession.mutateAsync(session.id)
              } catch (err) {
                console.error("Delete failed:", err)
                Alert.alert(t("sessionsList.alerts.deleteFailedTitle"), t("sessionsList.alerts.deleteFailedMessage"))
              }
            },
          },
        ],
      )
    },
    [deleteSession, t],
  )

  // Sessions are only ever created inside an explicitly chosen,
  // already-downloaded project (recents / server list / folder browser) —
  // never at the server root and never from a hand-typed path.
  // On the LAN tab an explicit LAN connectionId is always passed so the
  // session lands on the LAN server even if the active connection lagged
  // behind (and with connectionId::directory tagging + local badge +
  // /project/[directory]?connectionId routing the card shows up in the
  // LAN list right after creation).
  const onCreateInDirectory = async (dir: string, explicitConnectionId?: string) => {
    if (!activeConnection && !explicitConnectionId) return
    if (creatingInFlight.current) return
    creatingInFlight.current = true
    setIsCreating(true)

    try {
      const lanTarget =
        explicitConnectionId ??
        (sourceTab === "lan" && activeConnection?.discoveredOnLan ? activeConnection.id : undefined)
      // A custom directory uses a one-off client for that directory (the
      // mutation handles this via clientForDirectory) so the connection's
      // default project is never mutated.
      const { created: session, connectionId } = await createSession.mutateAsync(
        lanTarget ? { directory: dir.trim(), connectionId: lanTarget } : { directory: dir.trim() },
      )
      setShowNewSession(false)
      closeNewProject()
      router.push({
        pathname: `/session/[id]`,
        params: {
          id: session.id,
          ...(session.directory ? { directory: session.directory } : {}),
          connectionId,
        },
      })
    } catch (error) {
      console.error("Failed to create session in directory:", error)
      Alert.alert(t("common.error"), t("sessionsList.alerts.createFailedMessage"))
    } finally {
      creatingInFlight.current = false
      setIsCreating(false)
    }
  }

  // Both pickers are bottom sheets now, so they stack naturally (browser on
  // top) — no modal juggling and no restore dance needed. Keyboard is
  // dismissed first (see expandSheet): the browser may open on top of the
  // switcher's custom-path input with focus still in it.
  const openBrowser = useCallback(
    (startDir: string | null, mode: "create" | "switch") => {
      setBrowseStartDir(startDir || serverHome || null)
      setBrowseMode(mode)
      expandSheet(browserSheetRef)
    },
    [serverHome, expandSheet],
  )

  const onBrowserSelect = useCallback(
    (directory: string) => {
      if (browseMode === "switch") {
        handleSwitchDirectory(directory)
        dirSheetRef.current?.close()
      } else {
        onCreateInDirectory(directory)
      }
    },
    [browseMode, handleSwitchDirectory, onCreateInDirectory],
  )

  const onFabLongPress = () => {
    // Show the new-project sheet with more options
    setShowNewSession(true)
  }

  // NOTE: no early returns here on purpose — the source tabs (server/LAN)
  // must stay visible even with no connection or a failed auth, otherwise
  // the LAN screen is unreachable exactly when it's needed most. Each tab
  // renders its own state below.
  const shortPath = getShortPath(currentProject)

  return (
    <View style={[styles.container, isDark && styles.containerDark]}>
      {/* Project path — tap to switch (server name removed per request) */}
      {shortPath ? (
        <TouchableOpacity
          style={[styles.connectionBar, isDark && styles.connectionBarDark]}
          onPress={() => expandSheet(dirSheetRef)}
          activeOpacity={0.7}
          testID="connection-status-bar"
        >
          <View style={styles.connectionInfo}>
            <Ionicons name="folder" size={14} color={isDark ? "#888888" : "#666666"} />
            <Text style={[styles.projectPath, isDark && styles.metaDark]} numberOfLines={1}>
              {shortPath}
            </Text>
          </View>
          <Ionicons name="swap-horizontal-outline" size={16} color={isDark ? "#666666" : "#999999"} />
        </TouchableOpacity>
      ) : null}

      {sessionsError && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>
            {sessionsError instanceof Error ? sessionsError.message : String(sessionsError)}
          </Text>
        </View>
      )}

      <UpdateBanner isDark={isDark} />

      {sourceTab === "server" ? (
      !activeConnection ? (
        <View style={[styles.emptyContainer, isDark && styles.containerDark]}>
          <Ionicons name="lock-closed-outline" size={64} color={isDark ? "#444444" : "#cccccc"} />
          <Text style={[styles.emptyTitle, isDark && styles.textDark]}>Требуется вход</Text>
          <Text style={[styles.emptySubtitle, isDark && styles.metaDark]}>Требуется авторизация</Text>
          <TouchableOpacity
            style={[styles.addButton, isDark && styles.addButtonDark]}
            onPress={() => router.push("/login")}
            testID="go-login-button"
          >
            <Text style={[styles.addButtonText, isDark && styles.addButtonTextDark]}>Войти</Text>
          </TouchableOpacity>
        </View>
      ) : authError ? (
        <View style={[styles.emptyContainer, isDark && styles.containerDark]}>
          <Ionicons name="lock-closed-outline" size={64} color={isDark ? "#444444" : "#cccccc"} />
          <Text style={[styles.emptyTitle, isDark && styles.textDark]}>{t("sessionsList.empty.authFailedTitle")}</Text>
          <Text style={[styles.emptySubtitle, isDark && styles.metaDark]}>
            {t("sessionsList.empty.authFailedSubtitle", { name: activeConnection.name })}
          </Text>
          <TouchableOpacity
            style={[styles.addButton, isDark && styles.addButtonDark]}
            onPress={() => router.push("/login")}
            testID="go-login-button"
          >
            <Text style={[styles.addButtonText, isDark && styles.addButtonTextDark]}>Войти снова</Text>
          </TouchableOpacity>
        </View>
      ) : (
      <FlatList
        data={serverProjectsList}
        key={numColumns}
        numColumns={numColumns}
        keyExtractor={(item) => item.key}
        columnWrapperStyle={numColumns > 1 ? styles.projectGridRow : undefined}
        renderItem={({ item }) => (
          <ProjectCard
            directory={item.directory}
            connectionId={item.connectionId}
            isLocal={item.isLocal}
            count={item.count}
            lastUpdated={item.lastUpdated}
            isDark={isDark}
          />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={isDark ? "#ffffff" : "#0a0a0a"} />
        }
        testID="project-list"
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={isDark ? "#ffffff" : "#0a0a0a"} />
            </View>
          ) : (
            <View style={styles.emptyList}>
              <Text style={[styles.emptyListText, isDark && styles.metaDark]}>Нет проектов — создайте первый</Text>
            </View>
          )
        }
        contentContainerStyle={
          serverProjectsList.length === 0
            ? styles.emptyContent
            : [
                { padding: 16, gap: 12, paddingBottom: 88 },
                isWide && {
                  maxWidth: breakpoints.desktop,
                  width: "100%",
                  alignSelf: "center",
                },
              ]
        }
        style={{ flex: 1 }}
      />
      )
      ) : (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          { padding: 16, gap: 12, paddingBottom: 88 },
          isWide && {
            maxWidth: breakpoints.desktop,
            width: "100%",
            alignSelf: "center" as const,
          },
        ]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={isDark ? "#ffffff" : "#0a0a0a"} />
        }
        testID="lan-project-list"
      >
        {/* LAN-серверы: без записи здесь проекты локальной сети негде увидеть.
            Каждая строка — сервер с состоянием (активен / нужен вход). */}
        <Text style={[styles.modalLabel, isDark && styles.metaDark]}>{t("project.lanList.serversLabel")}</Text>
        {lanConnections.length === 0 ? (
          <View style={[styles.lanEmpty, isDark && styles.lanEmptyDark]}>
            <Ionicons name="wifi-outline" size={40} color={isDark ? "#444444" : "#cccccc"} />
            <Text style={[styles.lanEmptyTitle, isDark && styles.textDark]}>{t("project.lanList.noServersTitle")}</Text>
            <Text style={[styles.lanEmptyHint, isDark && styles.metaDark]}>{t("project.lanList.noServersHint")}</Text>
            <TouchableOpacity
              style={[styles.lanFindButton, isDark && styles.lanFindButtonDark]}
              onPress={handleFindLan}
              testID="lan-find-button"
            >
              <Ionicons name="search-outline" size={18} color={isDark ? "#0a0a0a" : "#ffffff"} />
              <Text style={[styles.lanFindButtonText, isDark && styles.lanFindButtonTextDark]}>
                {t("project.lanList.findButton")}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {lanConnections.map((c) => {
              const isActive = activeConnection?.id === c.id
              const hasAuth = !!clientBases[c.id]?.auth
              return (
                <View key={c.id} style={[styles.lanServerRow, isDark && styles.lanServerRowDark]}>
                  <Ionicons name="wifi" size={20} color={isDark ? "#888888" : "#666666"} />
                  <View style={styles.projectRowContent}>
                    <Text style={[styles.projectRowName, isDark && styles.textDark]} numberOfLines={1}>
                      {c.name}
                    </Text>
                    <Text style={[styles.projectRowPath, isDark && styles.metaDark]} numberOfLines={1}>
                      {c.url}
                    </Text>
                  </View>
                  {isActive ? (
                    <View style={[styles.activeBadge, isDark && styles.activeBadgeDark]}>
                      <Text style={[styles.activeBadgeText, isDark && styles.activeBadgeTextDark]}>
                        {t("project.lanList.activeBadge")}
                      </Text>
                    </View>
                  ) : hasAuth ? (
                    <TouchableOpacity
                      style={[styles.lanUseButton, isDark && styles.lanUseButtonDark]}
                      onPress={() => handleUseLan(c.id)}
                      testID={`lan-use-server-${c.id}`}
                    >
                      <Text style={[styles.lanUseButtonText, isDark && styles.lanUseButtonTextDark]}>
                        {t("project.lanList.useButton")}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.lanFindButton, isDark && styles.lanFindButtonDark]}
                      onPress={() => handleLoginLan(c.id)}
                      testID={`lan-login-server-${c.id}`}
                    >
                      <Text style={[styles.lanFindButtonText, isDark && styles.lanFindButtonTextDark]}>
                        {t("project.lanList.loginButton")}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {!hasAuth && !isActive && (
                    <Text style={styles.lanNeedsLogin}>{t("project.lanList.needsLogin")}</Text>
                  )}
                </View>
              )
            })}
            <TouchableOpacity
              style={[styles.lanScanRow, isDark && styles.projectRowDark]}
              onPress={handleFindLan}
              testID="lan-find-another-button"
            >
              <Ionicons name="search-outline" size={18} color={isDark ? "#888888" : "#666666"} />
              <Text style={[styles.projectRowName, isDark && styles.textDark]}>{t("lan.findAnother")}</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Проекты в локальной сети (сессии с LAN-подключений). */}
        <Text style={[styles.modalLabel, isDark && styles.metaDark, { marginTop: 8 }]}>
          {t("project.lanList.projectsLabel")}
        </Text>
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={isDark ? "#ffffff" : "#0a0a0a"} />
          </View>
        ) : lanProjectsList.length === 0 ? (
          <View style={styles.emptyList}>
            {serverProjectsError ? (
              <Text style={[styles.emptyListText, isDark && styles.metaDark]}>
                {serverProjectsError instanceof Error ? serverProjectsError.message : String(serverProjectsError)}
              </Text>
            ) : (
              <Text style={[styles.emptyListText, isDark && styles.metaDark]}>{t("project.lanList.noProjectsHint")}</Text>
            )}
            {activeConnection?.discoveredOnLan && serverProjectsData && serverProjectsData.length > 0 ? (
              <>
                {serverProjectsData.map((p) => {
                  const abs = p.path?.absolute
                  if (!abs) return null
                  const short = p.name || abs.split("/").filter(Boolean).pop() || p.id
                  return (
                    <TouchableOpacity
                      key={p.id}
                      style={[styles.projectRow, isDark && styles.projectRowDark, { marginTop: 8, alignSelf: "stretch" as const }]}
                      onPress={() => onCreateInDirectory(abs, activeConnection.id)}
                      disabled={isCreating}
                    >
                      <Ionicons name="code-slash-outline" size={18} color={isDark ? "#888888" : "#666666"} />
                      <View style={styles.projectRowContent}>
                        <Text style={[styles.projectRowName, isDark && styles.textDark]} numberOfLines={1}>
                          {short}
                        </Text>
                        <Text style={[styles.projectRowPath, isDark && styles.metaDark]} numberOfLines={1}>
                          {abs}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )
                })}
              </>
            ) : activeConnection?.discoveredOnLan ? (
              <TouchableOpacity
                style={[styles.lanFindButton, isDark && styles.lanFindButtonDark, { marginTop: 12 }]}
                onPress={() => setShowNewSession(true)}
                testID="lan-new-project-button"
              >
                <Ionicons name="add" size={18} color={isDark ? "#0a0a0a" : "#ffffff"} />
                <Text style={[styles.lanFindButtonText, isDark && styles.lanFindButtonTextDark]}>
                  {t("project.lanList.newProjectButton")}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
          <>
            {lanProjectsList.map((item) => (
              <ProjectCard
                key={item.key}
                directory={item.directory}
                connectionId={item.connectionId}
                isLocal={item.isLocal}
                count={item.count}
                lastUpdated={item.lastUpdated}
                isDark={isDark}
              />
            ))}
          </>
        )}
      </ScrollView>
      )}

      {/* Сегмент-переключатель «На сервере / В локальной сети» — живет только на
          странице проектов, чуть выше таб-бара, и переключает два списка выше. */}
      <View style={[styles.sourceTabsWrap, isDark && styles.sourceTabsWrapDark]}>
        <View style={[styles.sourceTabs, isDark && styles.sourceTabsDark]} testID="projects-source-tabs">
          {(["server", "lan"] as const).map((mode) => {
            const selected = sourceTab === mode
            return (
              <TouchableOpacity
                key={mode}
                style={[styles.sourceTab, selected && styles.sourceTabActive, selected && isDark && styles.sourceTabActiveDark]}
                onPress={() => setSourceTab(mode)}
                testID={`projects-tab-${mode}`}
              >
                <Text
                  style={[
                    styles.sourceTabText,
                    selected && styles.sourceTabTextActive,
                    selected && isDark && styles.sourceTabTextActiveDark,
                  ]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {t(mode === "server" ? "project.tabs.server" : "project.tabs.lan")}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </View>
      <LanDiscoveryModal visible={lanVisible} onClose={() => setLanVisible(false)} onPick={handlePickLan} />

      {/* FAB removed per request */}

      {/* New Project bottom sheet — also opened via Navbar New Project button.
          Only already-downloaded projects can be picked here (recents, server
          list, folder browser): no hand-typed paths and no server-root
          default, so sessions can never land in the projects root. */}
      <BottomSheet
        ref={newSheetRef}
        index={-1}
        snapPoints={newSheetSnapPoints}
        enableDynamicSizing={false}
        enablePanDownToClose
        enableHandlePanningGesture
        handleComponent={SheetHandle}
        backdropComponent={renderNewSheetBackdrop}
        backgroundStyle={[styles.sheet, isDark && styles.sheetDark]}
        onChange={(index) => {
          if (index === -1) closeNewSession()
        }}
      >
        <View style={[styles.modalHeader, capSheetContent && sheetContentCap]}>
          <Text style={[styles.modalTitle, isDark && styles.textDark]}>{t("sessionsList.newSessionModal.title")}</Text>
          <TouchableOpacity onPress={closeNewSession}>
            <Ionicons name="close" size={24} color={isDark ? "#ffffff" : "#0a0a0a"} />
          </TouchableOpacity>
        </View>

        <BottomSheetScrollView style={styles.modalScrollBody} contentContainerStyle={styles.modalScrollContent}>
          {/* Centered column on wide screens (cap on an inner View — on the
              scroll content container itself it would left-stick). */}
          <View style={capSheetContent && sheetContentCap}>
          {/* Recent projects */}
          {recentDirectories.length > 0 && (
            <>
              <Text style={[styles.modalLabel, isDark && styles.metaDark]}>
                {t("sessionsList.newSessionModal.recentProjectsLabel")}
              </Text>
                  {recentDirectories.map((dir) => {
                    const short = dir.split("/").filter(Boolean).pop() || dir
                    const isCurrent =
                      dir === (currentProject?.path?.absolute || activeConnection?.directory)
                    return (
                      <TouchableOpacity
                        key={dir}
                        style={[
                          styles.projectRow,
                          isDark && styles.projectRowDark,
                          isCurrent && styles.projectRowActive,
                        ]}
                        onPress={() => onCreateInDirectory(dir)}
                        disabled={isCreating}
                      >
                        <Ionicons
                          name="folder-outline"
                          size={18}
                          color={isCurrent ? colors.accent : isDark ? "#888888" : "#666666"}
                        />
                        <View style={styles.projectRowContent}>
                          <Text
                            style={[
                              styles.projectRowName,
                              isDark && styles.textDark,
                              isCurrent && styles.projectRowNameActive,
                            ]}
                            numberOfLines={1}
                          >
                            {short}
                          </Text>
                          <Text style={[styles.projectRowPath, isDark && styles.metaDark]} numberOfLines={1}>
                            {dir}
                          </Text>
                        </View>
                        {isCurrent && <Ionicons name="checkmark-circle" size={18} color={colors.accent} />}
                      </TouchableOpacity>
                    )
                  })}
                </>
              )}

              {/* Server-known projects (excluding current) */}
              {serverProjects.filter((p) => p.path?.absolute !== currentProject?.path?.absolute).length > 0 && (
                <>
                  <Text style={[styles.modalLabel, isDark && styles.metaDark, { marginTop: 16 }]}>
                    {t("sessionsList.newSessionModal.serverProjectsLabel")}
                  </Text>
                  {serverProjects
                    .filter((p) => p.path?.absolute !== currentProject?.path?.absolute)
                    .map((p) => {
                      const short = p.name || p.path?.absolute?.split("/").filter(Boolean).pop() || p.id
                      return (
                        <TouchableOpacity
                          key={p.id}
                          style={[styles.projectRow, isDark && styles.projectRowDark]}
                          onPress={() => onCreateInDirectory(p.path?.absolute)}
                          disabled={isCreating}
                        >
                          <Ionicons name="code-slash-outline" size={18} color={isDark ? "#888888" : "#666666"} />
                          <View style={styles.projectRowContent}>
                            <Text style={[styles.projectRowName, isDark && styles.textDark]} numberOfLines={1}>
                              {short}
                            </Text>
                            {p.path?.absolute && (
                              <Text style={[styles.projectRowPath, isDark && styles.metaDark]} numberOfLines={1}>
                                {p.path.absolute}
                              </Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      )
                    })}
                </>
              )}

              {/* Browse the server's filesystem instead of typing a path */}
              <TouchableOpacity
                style={[styles.projectRow, isDark && styles.projectRowDark, { marginTop: 16 }]}
                onPress={() =>
                  openBrowser(currentProject?.path?.absolute || activeConnection?.directory || null, "create")
                }
                disabled={isCreating}
                testID="browse-folders-button"
              >
                <Ionicons name="folder-open-outline" size={18} color={isDark ? colors.accentPale : colors.accentStrong} />
                <View style={styles.projectRowContent}>
                  <Text style={[styles.projectRowName, isDark && styles.textDark]}>
                    {t("sessionsList.newSessionModal.browseFoldersLabel")}
                  </Text>
                  <Text style={[styles.projectRowPath, isDark && styles.metaDark]}>
                    {t("sessionsList.newSessionModal.browseFoldersHint")}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={isDark ? "#666666" : "#999999"} />
              </TouchableOpacity>

              {/* Clone a GitHub repo onto the server (stub — backend lands later).
                  Opens as a bottom sheet stacked above this one. */}
              <TouchableOpacity
                style={[styles.projectRow, isDark && styles.projectRowDark, { marginTop: 8 }]}
                onPress={() => {
                  closeNewSession()
                  expandSheet(cloneSheetRef)
                }}
                disabled={isCreating}
                testID="clone-repo-button"
              >
                <Ionicons name="logo-github" size={18} color={isDark ? colors.accentPale : colors.accentStrong} />
                <View style={styles.projectRowContent}>
                  <Text style={[styles.projectRowName, isDark && styles.textDark]}>
                    {t("sessionsList.newSessionModal.cloneRepoLabel")}
                  </Text>
                  <Text style={[styles.projectRowPath, isDark && styles.metaDark]}>
                    {t("sessionsList.newSessionModal.cloneRepoHint")}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={isDark ? "#666666" : "#999999"} />
              </TouchableOpacity>

            </View>
            </BottomSheetScrollView>
      </BottomSheet>

      {/* Rename modal */}
      <Modal visible={!!renaming} animationType="fade" transparent>
        <KeyboardAvoidingView
          style={[styles.modalOverlay, { justifyContent: "center" }]}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <TouchableOpacity style={styles.modalDismiss} activeOpacity={1} onPress={() => setRenaming(null)} />
          <View style={[styles.renameCard, isDark && styles.renameCardDark]}>
            <Text style={[styles.renameTitle, isDark && styles.textDark]}>{t("sessionsList.renameModal.title")}</Text>
            <TextInput
              style={[styles.modalInput, isDark && styles.modalInputDark]}
              value={renameText}
              onChangeText={setRenameText}
              onSubmitEditing={submitRename}
              returnKeyType="done"
              autoFocus
              selectTextOnFocus
              autoCapitalize="sentences"
              autoCorrect={false}
            />
            <View style={styles.renameActions}>
              <TouchableOpacity style={[styles.renameBtn, styles.renameBtnCancel]} onPress={() => setRenaming(null)}>
                <Text style={styles.renameBtnCancelText}>{t("common.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.renameBtn, styles.modalButtonPrimary, isDark && styles.modalButtonPrimaryDark]}
                onPress={submitRename}
                disabled={!renameText.trim()}
              >
                <Text style={[styles.modalButtonTextPrimary, isDark && styles.modalButtonTextPrimaryDark]}>
                  {t("common.save")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          <TouchableOpacity style={styles.modalDismiss} activeOpacity={1} onPress={() => setRenaming(null)} />
        </KeyboardAvoidingView>
      </Modal>

      {/* Directory switcher bottom sheet */}
      <DirectorySwitcher
        sheetRef={dirSheetRef}
        current={activeConnection?.directory}
        recents={recentDirectories}
        serverHome={serverHome}
        isDark={isDark}
        onSwitch={handleSwitchDirectory}
        onBrowse={() =>
          openBrowser(activeConnection?.directory || currentProject?.path?.absolute || null, "switch")
        }
      />

      {/* Browsable folder picker — used for both "new session in..." and
          "switch project directory" flows (see browseMode). */}
      <DirectoryBrowserSheet
        sheetRef={browserSheetRef}
        startDirectory={browseStartDir}
        clientForDirectory={clientForDirectory}
        isDark={isDark}
        onSelect={onBrowserSelect}
      />

      {/* GitHub clone flow — bottom sheet stacked above the new-project
          sheet (which closes first, see the clone row above). */}
      <CloneRepoSheet sheetRef={cloneSheetRef} isDark={isDark} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  containerDark: {
    backgroundColor: "#0a0a0a",
  },
  connectionBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
  },
  connectionBarDark: {
    borderBottomColor: "#1a1a1a",
  },
  connectionInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connectionName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  connectionUrl: {
    fontSize: 12,
    color: "#666666",
  },
  projectPath: {
    fontSize: 13,
    color: "#666666",
    flex: 1,
  },
  errorBar: {
    backgroundColor: "#fef2f2",
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#fecaca",
  },
  errorText: {
    color: "#dc2626",
    fontSize: 14,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#f5f5f5",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
  },
  groupHeaderDark: {
    backgroundColor: "#151515",
    borderBottomColor: "#1a1a1a",
  },
  groupHeaderText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  groupHeaderCount: {
    fontSize: 12,
    color: "#666666",
  },
  textDark: {
    color: "#ffffff",
  },
  metaDark: {
    color: "#888888",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
    backgroundColor: "#ffffff",
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
    marginTop: 16,
    color: "#0a0a0a",
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#666666",
    marginTop: 8,
    textAlign: "center",
  },
  addButton: {
    backgroundColor: "#0a0a0a",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 24,
  },
  authErrorButtonRow: {
    flexDirection: "row",
    gap: 12,
  },
  addButtonDark: {
    backgroundColor: "#ffffff",
  },
  addButtonText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  addButtonTextDark: {
    color: "#0a0a0a",
  },
  setupGuideLink: {
    marginTop: 16,
  },
  setupGuideLinkText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.accent,
  },
  tryDemoButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  tryDemoButtonDark: {
    borderColor: colors.accentPale,
  },
  tryDemoButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.accentStrong,
  },
  tryDemoButtonTextDark: {
    color: colors.accentPale,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 64,
  },
  emptyList: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 64,
  },
  emptyListText: {
    fontSize: 16,
    color: "#666666",
  },
  emptyContent: {
    flex: 1,
  },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#0a0a0a",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  fabDark: {
    backgroundColor: "#ffffff",
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  modalDismiss: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
    paddingHorizontal: 16,
  },
  sheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  sheetDark: {
    backgroundColor: "#1a1a1a",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  modalBody: {
    marginBottom: 24,
  },
  modalScrollBody: {
    maxHeight: 420,
  },
  modalScrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: "#f5f5f5",
    marginBottom: 6,
  },
  projectRowDark: {
    backgroundColor: "#2a2a2a",
  },
  projectRowActive: {
    backgroundColor: colors.accentMuted,
  },
  projectRowContent: {
    flex: 1,
  },
  projectRowName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  projectRowNameActive: {
    color: colors.accent,
  },
  projectRowPath: {
    fontSize: 11,
    color: "#999999",
    marginTop: 1,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#666666",
    marginBottom: 8,
    textTransform: "uppercase",
  },
  modalInput: {
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: "#0a0a0a",
  },
  modalInputDark: {
    backgroundColor: "#2a2a2a",
    color: "#ffffff",
  },
  modalHint: {
    fontSize: 13,
    color: "#666666",
    marginTop: 12,
  },
  modalButtonPrimary: {
    backgroundColor: "#0a0a0a",
  },
  modalButtonPrimaryDark: {
    backgroundColor: "#ffffff",
  },
  modalButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  modalButtonTextPrimary: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ffffff",
  },
  modalButtonTextPrimaryDark: {
    color: "#0a0a0a",
  },
  // Rename modal
  renameCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 32,
    gap: 16,
  },
  renameCardDark: {
    backgroundColor: "#1a1a1a",
  },
  renameTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  renameActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
  },
  renameBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
  renameBtnCancel: {
    backgroundColor: "transparent",
  },
  renameBtnCancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#888888",
  },
  input: {
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: "#0a0a0a",
  },
  inputDark: {
    backgroundColor: "#2a2a2a",
    color: "#ffffff",
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0a0a0a",
    marginTop: 16,
    marginBottom: 8,
  },
  labelDark: {
    color: "#ffffff",
  },
  projectCard: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    gap: 6,
  },
  projectGridRow: {
    gap: 12,
  },
  projectCardDark: {
    backgroundColor: "#1a1a1a",
    borderColor: "#2a2a2a",
  },
  projectCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  projectCardTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0a0a0a",
    flex: 1,
  },
  projectCardPath: {
    fontSize: 13,
    color: "#666666",
  },
  projectCardMeta: {
    fontSize: 12,
    color: "#999999",
    marginTop: 4,
  },
  countBadge: {
    backgroundColor: "#f5f5f5",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  countBadgeDark: {
    backgroundColor: "#2a2a2a",
  },
  countBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#666666",
  },
  countBadgeTextDark: {
    color: "#888888",
  },
  localBadge: {
    backgroundColor: "#dcfce7",
    borderWidth: 1,
    borderColor: "#bbf7d0",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  localBadgeDark: {
    backgroundColor: "#052e16",
    borderColor: "#14532d",
  },
  localBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#15803d",
  },
  localBadgeTextDark: {
    color: "#4ade80",
  },
  // Сегмент-переключатель источника проектов — плашка чуть выше таб-бара.
  // Ширина жестко ограничена: wrap дает боковые поля, контейнер — maxWidth,
  // табы делят место поровну (flex: 1 + minWidth: 0), текст в одну строку с
  // троеточием. Длинный перевод или крупный шрифт сожмут табы, а не вылезут
  // за край экрана.
  sourceTabsWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 12,
    alignItems: "center",
    paddingHorizontal: 16,
  },
  sourceTabsWrapDark: {},
  sourceTabs: {
    flexDirection: "row",
    width: "100%",
    maxWidth: 480,
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 4,
    gap: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    // No Android elevation on purpose: the floating tabs must stay UNDER the
    // bottom sheets (new-project, browser) — elevation would punch them
    // through the open sheet. iOS keeps its shadow via shadow* above.
  },
  sourceTabsDark: {
    backgroundColor: "#1a1a1a",
  },
  sourceTab: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  sourceTabActive: {
    backgroundColor: "#0a0a0a",
  },
  sourceTabActiveDark: {
    backgroundColor: "#ffffff",
  },
  sourceTabText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#666666",
    textAlign: "center",
    flexShrink: 1,
  },
  sourceTabTextActive: {
    color: "#ffffff",
  },
  sourceTabTextActiveDark: {
    color: "#0a0a0a",
  },
  // LAN-экран
  lanEmpty: {
    alignItems: "center",
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 24,
    gap: 8,
  },
  lanEmptyDark: {
    backgroundColor: "#1a1a1a",
  },
  lanEmptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0a0a0a",
    marginTop: 8,
  },
  lanEmptyHint: {
    fontSize: 13,
    color: "#666666",
    textAlign: "center",
    lineHeight: 20,
  },
  lanFindButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#0a0a0a",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 12,
  },
  lanFindButtonDark: {
    backgroundColor: "#ffffff",
  },
  lanFindButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ffffff",
  },
  lanFindButtonTextDark: {
    color: "#0a0a0a",
  },
  lanServerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#f5f5f5",
  },
  lanServerRowDark: {
    backgroundColor: "#2a2a2a",
  },
  lanScanRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: "#f5f5f5",
    borderStyle: "dashed",
  },
  lanUseButton: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#0a0a0a",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  lanUseButtonDark: {
    borderColor: "#ffffff",
  },
  lanUseButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  lanUseButtonTextDark: {
    color: "#ffffff",
  },
  lanNeedsLogin: {
    fontSize: 11,
    color: "#f59e0b",
    fontWeight: "600",
  },
  activeBadge: {
    backgroundColor: "#dcfce7",
    borderWidth: 1,
    borderColor: "#bbf7d0",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  activeBadgeDark: {
    backgroundColor: "#052e16",
    borderColor: "#14532d",
  },
  activeBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#15803d",
  },
  activeBadgeTextDark: {
    color: "#4ade80",
  },
})
