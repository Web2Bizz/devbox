import { useMemo } from "react"
import { View, Text, FlatList, TouchableOpacity, StyleSheet, useColorScheme } from "react-native"
import { router } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { useSessions } from "../../src/stores/sessions"
import { useSessionsList } from "../../src/queries/sessions"
import { useEvents } from "../../src/stores/events"
import { selectActiveSessions } from "../../src/lib/active-tasks"
import { colors } from "@web2bizz/ui-native"
import type { ListedSession } from "../../src/lib/listed-session"

// Tasks = sessions where the agent is currently doing something:
// SSE sessionStatus busy/retry, plus optimistic sending (tap → SSE busy gap).
export default function TasksScreen() {
  const isDark = useColorScheme() === "dark"
  const { t } = useTranslation()
  // Server snapshot from the React Query cache (auto-fetched, SSE-synced,
  // refetched on foreground) — the single source the badge counts too.
  const { data: sessions } = useSessionsList()
  const sessionStatus = useEvents((s) => s.sessionStatus)
  const statusText = useEvents((s) => s.statusText)
  const sending = useSessions((s) => s.sending)

  const active = selectActiveSessions(sessions ?? [], sessionStatus, sending)

  // Group by project directory — only projects with ≥1 active task appear
  // (inactive sessions never enter `active`, so empty groups can't exist).
  const groups = useMemo(() => {
    const byDir = new Map<string, ListedSession[]>()
    for (const session of active) {
      const key = session.directory || ""
      const list = byDir.get(key)
      if (list) list.push(session)
      else byDir.set(key, [session])
    }
    return [...byDir.entries()]
      .map(([directory, items]) => ({
        directory,
        shortName: directory.split("/").filter(Boolean).pop() || "—",
        items,
      }))
      .sort((a, b) => a.shortName.localeCompare(b.shortName))
  }, [active])

  const renderTask = (item: ListedSession) => {
    const st = sessionStatus[item.id]
    const isRetry = st?.type === "retry"
    const text = statusText[item.id] || t("tasks.working")
    return (
      <TouchableOpacity
        style={[styles.row, isDark && styles.rowDark]}
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
        testID={`task-item-${item.id}`}
      >
        <View style={[styles.dot, isRetry && styles.dotRetry]}>
          <View style={[styles.pulse, isRetry && styles.pulseRetry]} />
        </View>
        <View style={styles.content}>
          <Text style={[styles.title, isDark && styles.textDark]} numberOfLines={1}>
            {item.title || t("sessionsList.untitledSession")}
          </Text>
          <Text style={[styles.status, isRetry && styles.statusRetry]} numberOfLines={1}>
            {isRetry ? t("tasks.retrying") : text}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={isDark ? "#666666" : "#999999"} />
      </TouchableOpacity>
    )
  }

  return (
    <View style={[styles.container, isDark && styles.containerDark]}>
      <FlatList
        data={groups}
        keyExtractor={(g) => g.directory}
        renderItem={({ item: group }) => (
          <View style={styles.group}>
            <View style={styles.groupHeader}>
              <Ionicons name="folder" size={16} color={isDark ? colors.accentPale : colors.accentStrong} />
              <Text style={[styles.groupTitle, isDark && styles.textDark]} numberOfLines={1}>
                {group.shortName}
              </Text>
              <Text style={[styles.groupCount, isDark && styles.metaDark]}>{group.items.length}</Text>
            </View>
            <View style={styles.groupList}>{group.items.map(renderTask)}</View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty} testID="tasks-empty">
            <Ionicons name="checkmark-circle-outline" size={64} color={isDark ? "#444444" : "#cccccc"} />
            <Text style={[styles.emptyTitle, isDark && styles.textDark]}>{t("tasks.empty")}</Text>
            <Text style={[styles.emptyHint, isDark && styles.metaDark]}>{t("tasks.emptyHint")}</Text>
          </View>
        }
        contentContainerStyle={groups.length === 0 ? styles.emptyContent : styles.listContent}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e5e5",
  },
  rowDark: { backgroundColor: "#1a1a1a", borderColor: "#2a2a2a" },
  listContent: { padding: 16, gap: 16 },
  group: { gap: 12 },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 4,
  },
  groupTitle: { flex: 1, fontSize: 14, fontWeight: "600", color: "#0a0a0a" },
  groupCount: { fontSize: 12, color: "#666666" },
  groupList: { gap: 12 },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#dcfce7",
    alignItems: "center",
    justifyContent: "center",
  },
  dotRetry: { backgroundColor: "#fef3c7" },
  pulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#22c55e" },
  pulseRetry: { backgroundColor: "#f59e0b" },
  content: { flex: 1 },
  title: { fontSize: 16, fontWeight: "500", color: "#0a0a0a", marginBottom: 2 },
  textDark: { color: "#ffffff" },
  status: { fontSize: 13, color: "#15803d", flex: 1 },
  statusRetry: { color: "#b45309" },
  metaDark: { color: "#888888" },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  emptyContent: { flex: 1 },
  emptyTitle: { fontSize: 20, fontWeight: "600", marginTop: 16, color: "#0a0a0a" },
  emptyHint: { fontSize: 14, color: "#666666", marginTop: 8, textAlign: "center" },
})
