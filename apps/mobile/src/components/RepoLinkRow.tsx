import { View, Text, TouchableOpacity, StyleSheet, Linking } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { RepoLink, GitProvider } from "../lib/git-remotes"

// Ionicons brand glyph per git host; self-hosted/unknown fall back to a
// generic branch icon (Ionicons has no gitea/self-hosted glyphs).
export function providerIconName(provider: GitProvider): keyof typeof Ionicons.glyphMap {
  switch (provider) {
    case "github":
      return "logo-github"
    case "gitlab":
      return "logo-gitlab"
    case "bitbucket":
      return "logo-bitbucket"
    default:
      return "git-branch-outline"
  }
}

// One tappable repository row: provider icon + "owner/repo" slug, remote
// name as secondary line. Shared by the project header card (top 3) and the
// full remotes screen — app-bound, so it lives in src/components.
export function RepoLinkRow({ repo, isDark }: { repo: RepoLink; isDark: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.row, isDark && styles.rowDark]}
      onPress={() => void Linking.openURL(repo.webUrl).catch(() => {})}
      testID={`repo-link-${repo.name}`}
      accessibilityRole="link"
      accessibilityLabel={repo.webUrl}
    >
      <Ionicons name={providerIconName(repo.provider)} size={18} color={isDark ? "#bbbbbb" : "#444444"} />
      <View style={styles.content}>
        <Text style={[styles.slug, isDark && styles.textDark]} numberOfLines={1}>
          {repo.slug}
        </Text>
        <Text style={[styles.remoteName, isDark && styles.metaDark]} numberOfLines={1}>
          {repo.name}
        </Text>
      </View>
      <Ionicons name="open-outline" size={16} color={isDark ? "#666666" : "#999999"} />
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#ffffff",
  },
  rowDark: { backgroundColor: "#1a1a1a", borderColor: "#2a2a2a" },
  content: { flex: 1 },
  slug: { fontSize: 14, fontWeight: "600", color: "#0a0a0a" },
  textDark: { color: "#ffffff" },
  remoteName: { fontSize: 12, color: "#666666", marginTop: 1 },
  metaDark: { color: "#888888" },
})
