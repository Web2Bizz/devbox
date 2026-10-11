import { View, Text, FlatList, StyleSheet, useColorScheme, ActivityIndicator } from "react-native"
import { Stack, useLocalSearchParams } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { useProjectRemotes } from "../../src/queries/project"
import { RepoLinkRow } from "../../src/components/RepoLinkRow"

// Full remote list of a project (the header card shows the first 3).
// Params mirror the project screen: encoded directory + origin connectionId.
export default function ProjectRemotesScreen() {
  const { directory, connectionId } = useLocalSearchParams<{ directory: string; connectionId?: string }>()
  const decodedDir = directory ? decodeURIComponent(directory) : ""
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()
  const { data: remotesData, isLoading } = useProjectRemotes(decodedDir, connectionId)
  const remotes = remotesData ?? []

  return (
    <>
      <Stack.Screen options={{ title: t("project.remotes.title") }} />
      <View style={[styles.container, isDark && styles.containerDark]}>
        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color={isDark ? "#ffffff" : "#0a0a0a"} />
          </View>
        ) : (
          <FlatList
            data={remotes}
            keyExtractor={(item) => item.name}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => <RepoLinkRow repo={item} isDark={isDark} />}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="git-branch-outline" size={48} color={isDark ? "#444444" : "#cccccc"} />
                <Text style={[styles.emptyText, isDark && styles.metaDark]}>{t("project.remotes.empty")}</Text>
              </View>
            }
          />
        )}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  listContent: { padding: 16, gap: 8 },
  loading: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 64 },
  emptyText: { fontSize: 16, color: "#666666", marginTop: 12 },
  metaDark: { color: "#888888" },
})
