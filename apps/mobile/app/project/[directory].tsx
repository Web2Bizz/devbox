import { useCallback, useMemo } from "react"
import { View, Text, FlatList, TouchableOpacity, StyleSheet, useColorScheme, ActivityIndicator, Alert } from "react-native"
import { Stack, useLocalSearchParams, router } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { useSessionsList, useCreateSession, useDeleteSession } from "../../src/queries/sessions"
import { useProjectRemotes } from "../../src/queries/project"
import { useConnections } from "../../src/stores/connections"
import { RepoLinkRow } from "../../src/components/RepoLinkRow"
import { colors } from "@web2bizz/ui-native"

// How many remotes the header card shows before collapsing the rest behind
// the "show all" button (-> the full remotes screen).
const MAX_VISIBLE_REMOTES = 3

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

export default function ProjectSessionsScreen() {
  const { directory, connectionId } = useLocalSearchParams<{ directory: string; connectionId?: string }>()
  const decodedDir = directory ? decodeURIComponent(directory) : ""
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()
  const { data: sessionsData, isLoading } = useSessionsList()
  const sessions = sessionsData ?? []
  const deleteSession = useDeleteSession()
  const createSession = useCreateSession()
  const { activeConnection } = useConnections()

  const projectSessions = useMemo(
    () =>
      sessions.filter((s) => (s.directory || "") === decodedDir && (!connectionId || s.connectionId === connectionId)),
    [sessions, decodedDir, connectionId],
  )

  const shortName = decodedDir.split("/").filter(Boolean).pop() || decodedDir || "—"

  // Project description — hardcoded empty: the server exposes no description
  // field yet, the slot is here for when it does.
  const description = ""

  const { data: remotesData } = useProjectRemotes(decodedDir, connectionId)
  const remotes = remotesData ?? []
  const visibleRemotes = remotes.slice(0, MAX_VISIBLE_REMOTES)

  const openAllRemotes = useCallback(() => {
    router.push({
      pathname: "/project/remotes",
      params: {
        directory: encodeURIComponent(decodedDir),
        ...(connectionId ? { connectionId } : {}),
      },
    })
  }, [decodedDir, connectionId])

  const handleDelete = useCallback(
    (session: (typeof sessions)[number]) => {      Alert.alert(
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
              } catch {
                Alert.alert(t("sessionsList.alerts.deleteFailedTitle"), t("sessionsList.alerts.deleteFailedMessage"))
              }
            },
          },
        ],
      )
    },
    [deleteSession, t],
  )

  const handleRename = useCallback(
    (session: (typeof sessions)[number]) => {
      // For now, just show alert — full rename modal is in main list
      Alert.alert("Rename", `Rename ${session.title || "session"} — use main list for now`)
    },
    [],
  )

  return (
    <>
      <Stack.Screen options={{ title: shortName, headerBackTitle: "Проекты" }} />
      <View style={[styles.container, isDark && styles.containerDark]}>
        <FlatList
          data={projectSessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={[styles.headerCard, isDark && styles.headerCardDark]} testID="project-header-card">
              <View style={styles.headerTop}>
                <Ionicons name="folder" size={24} color={isDark ? colors.accentPale : colors.accentStrong} />
                <View style={styles.headerInfo}>
                  <Text style={[styles.title, isDark && styles.textDark]} numberOfLines={1}>
                    {shortName}
                  </Text>
                  {description ? (
                    <Text style={[styles.description, isDark && styles.metaDark]} numberOfLines={2}>
                      {description}
                    </Text>
                  ) : null}
                </View>
                <Text style={[styles.count, isDark && styles.metaDark]}>{projectSessions.length}</Text>
              </View>

              {remotes.length > 0 && (
                <View style={styles.reposSection}>
                  <Text style={[styles.reposLabel, isDark && styles.metaDark]}>
                    {t("project.header.repositoriesLabel")}
                  </Text>
                  {visibleRemotes.map((repo) => (
                    <RepoLinkRow key={repo.name} repo={repo} isDark={isDark} />
                  ))}
                  {remotes.length > MAX_VISIBLE_REMOTES && (
                    <TouchableOpacity
                      style={[styles.showAllBtn, isDark && styles.showAllBtnDark]}
                      onPress={openAllRemotes}
                      testID="show-all-remotes"
                    >
                      <Text style={[styles.showAllText, isDark && styles.showAllTextDark]}>
                        {t("project.header.showAll", { count: remotes.length })}
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color={isDark ? "#888888" : "#666666"} />
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.sessionItem, isDark && styles.sessionItemDark]}
              onPress={() =>
                router.push({
                  pathname: "/session/[id]",
                  params: {
                    id: item.id,
                    ...(item.directory ? { directory: item.directory } : {}),
                    connectionId: item.connectionId,
                  },
                })
              }
              onLongPress={() =>
                Alert.alert(item.title || t("sessionsList.untitledSession"), undefined, [
                  { text: t("common.cancel"), style: "cancel" },
                  { text: t("sessionsList.actions.rename"), onPress: () => handleRename(item) },
                  { text: t("common.delete"), style: "destructive", onPress: () => handleDelete(item) },
                ])
              }
            >
              <View style={styles.sessionContent}>
                <Text style={[styles.sessionTitle, isDark && styles.textDark]} numberOfLines={1}>
                  {item.title || t("sessionsList.untitledSession")}
                </Text>
                <Text style={[styles.sessionMeta, isDark && styles.metaDark]}>
                  {formatTime(item.time.updated, t)}
                  {item.summary && item.summary.files > 0 ? ` · ${t("sessionsList.filesCount", { count: item.summary.files })}` : ""}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={isDark ? "#666666" : "#999999"} />
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.loading}>
                <ActivityIndicator size="large" color={isDark ? "#ffffff" : "#0a0a0a"} />
              </View>
            ) : (
              <View style={styles.empty}>
                <Ionicons name="chatbubbles-outline" size={48} color={isDark ? "#444444" : "#cccccc"} />
                <Text style={[styles.emptyText, isDark && styles.metaDark]}>{t("sessionsList.empty.noSessions")}</Text>
              </View>
            )
          }
        />

        <TouchableOpacity
          style={[styles.fab, isDark && styles.fabDark]}
          onPress={async () => {
            // Origin-aware: a LAN project's sessions are created on ITS server.
            if (!activeConnection && !connectionId) return
            try {
              const { created: session, connectionId: createdConn } = await createSession.mutateAsync({
                directory: decodedDir,
                connectionId,
              })
              router.push({
                pathname: "/session/[id]",
                params: {
                  id: session.id,
                  ...(session.directory ? { directory: session.directory } : { directory: decodedDir }),
                  ...(createdConn ? { connectionId: createdConn } : {}),
                },
              })
            } catch {
              Alert.alert(t("common.error"), t("sessionsList.alerts.createFailedMessage"))
            }
          }}
          testID="new-session-in-project-fab"
        >
          <Ionicons name="add" size={28} color={isDark ? "#0a0a0a" : "#ffffff"} />
        </TouchableOpacity>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  // Шапка проекта — статичная карточка внутри скролл-контейнера
  // (ListHeaderComponent): те же токены, что у карточек сессий ниже
  // (sessionItem: radius 12, border 1, padding 16).
  headerCard: {
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#ffffff",
  },
  headerCardDark: { backgroundColor: "#1a1a1a", borderColor: "#2a2a2a" },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  headerInfo: { flex: 1 },
  title: { fontSize: 18, fontWeight: "700", color: "#0a0a0a" },
  description: { fontSize: 13, color: "#666666", marginTop: 2 },
  textDark: { color: "#ffffff" },
  count: { fontSize: 12, color: "#666666" },
  metaDark: { color: "#888888" },
  reposSection: { gap: 8 },
  reposLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#666666",
    textTransform: "uppercase",
  },
  showAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#ffffff",
  },
  showAllBtnDark: { backgroundColor: "#1a1a1a", borderColor: "#2a2a2a" },
  showAllText: { fontSize: 14, fontWeight: "600", color: "#0a0a0a" },
  showAllTextDark: { color: "#ffffff" },
  sessionItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e5e5",
  },
  sessionItemDark: { backgroundColor: "#1a1a1a", borderColor: "#2a2a2a" },
  listContent: { padding: 16, gap: 12 },
  sessionContent: { flex: 1 },
  sessionTitle: { fontSize: 16, fontWeight: "500", color: "#0a0a0a", marginBottom: 4 },
  sessionMeta: { fontSize: 13, color: "#666666" },
  loading: { flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 64 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 64 },
  emptyText: { fontSize: 16, color: "#666666", marginTop: 12 },
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
    elevation: 5,
  },
  fabDark: { backgroundColor: "#ffffff" },
})
