import { View, Text, TouchableOpacity, ScrollView, StyleSheet, useColorScheme, Alert } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { router } from "expo-router"
import { useConnections } from "../../src/stores/connections"
import { layout } from "@web2bizz/ui-native"

export default function AccountScreen() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()
  const { activeConnection, logoutAll } = useConnections()

  const handleLogout = () => {
    Alert.alert(t("settings.logout.confirmTitle"), t("settings.logout.confirmMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.logout.button"),
        style: "destructive",
        onPress: async () => {
          // Full logout (all connections, cloud + LAN): with a remaining
          // valid connection the auth gate would bounce straight back into
          // the app instead of showing the login entry choice.
          await logoutAll()
          router.replace("/login")
        },
      },
    ])
  }

  if (!activeConnection) {
    return (
      <ScrollView
        style={[styles.container, isDark && styles.containerDark]}
        contentContainerStyle={styles.content}
      >
        <Ionicons name="person-circle-outline" size={80} color={isDark ? "#444444" : "#cccccc"} />
        <Text style={[styles.title, isDark && styles.textDark]}>{t("account.notLoggedIn")}</Text>
        <TouchableOpacity
          style={[styles.loginButton, isDark && styles.loginButtonDark]}
          onPress={() => router.replace("/login")}
          testID="account-login-button"
        >
          <Text style={[styles.loginButtonText, isDark && styles.loginButtonTextDark]}>{t("common.retry")}</Text>
        </TouchableOpacity>
      </ScrollView>
    )
  }

  return (
    <ScrollView
      style={[styles.container, isDark && styles.containerDark]}
      contentContainerStyle={styles.content}
    >
      <View style={styles.header}>
        <View style={[styles.avatar, isDark && styles.avatarDark]}>
          <Ionicons name="person" size={48} color={isDark ? "#ffffff" : "#0a0a0a"} />
        </View>
        <Text style={[styles.username, isDark && styles.textDark]}>{activeConnection.username || "—"}</Text>
        <Text style={[styles.subtitle, isDark && styles.subtitleDark]}>{t("account.subtitle")}</Text>
      </View>

      <View style={[styles.card, isDark && styles.cardDark]}>
        <View style={styles.row}>
          <Ionicons name="person-outline" size={20} color={isDark ? "#888888" : "#666666"} />
          <View style={styles.rowContent}>
            <Text style={[styles.rowLabel, isDark && styles.textDark]}>{t("account.username")}</Text>
            <Text style={[styles.rowValue, isDark && styles.subtitleDark]}>{activeConnection.username || "—"}</Text>
          </View>
        </View>
        <View style={[styles.divider, isDark && styles.dividerDark]} />
        <View style={styles.row}>
          <Ionicons name="server-outline" size={20} color={isDark ? "#888888" : "#666666"} />
          <View style={styles.rowContent}>
            <Text style={[styles.rowLabel, isDark && styles.textDark]}>{t("account.server")}</Text>
            <Text style={[styles.rowValue, isDark && styles.subtitleDark]}>{activeConnection.name}</Text>
          </View>
        </View>
      </View>

      <TouchableOpacity
        style={[styles.logoutButton, isDark && styles.logoutButtonDark]}
        onPress={handleLogout}
        testID="account-logout-button"
      >
        <Ionicons name="log-out-outline" size={20} color="#ef4444" />
        <Text style={styles.logoutButtonText}>{t("account.logout")}</Text>
      </TouchableOpacity>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  content: {
    flexGrow: 1,
    // Same shared container token as settings and the tab headers — the old
    // hardcoded 24 made the card list 8pt narrower per side.
    paddingHorizontal: layout.containerPadding,
    paddingVertical: 24,
    maxWidth: layout.contentMaxWidth,
    alignSelf: "center",
    width: "100%",
  },
  header: { alignItems: "center", marginTop: 32, marginBottom: 32 },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#f5f5f5",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  avatarDark: { backgroundColor: "#1a1a1a" },
  username: { fontSize: 22, fontWeight: "700", color: "#0a0a0a" },
  textDark: { color: "#ffffff" },
  subtitle: { fontSize: 14, color: "#666666", marginTop: 4 },
  subtitleDark: { color: "#888888" },
  title: { fontSize: 20, fontWeight: "600", color: "#0a0a0a", marginTop: 16 },
  card: {
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  cardDark: { backgroundColor: "#1a1a1a" },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowContent: { flex: 1 },
  rowLabel: { fontSize: 13, color: "#666666", fontWeight: "500" },
  rowValue: { fontSize: 15, color: "#0a0a0a", marginTop: 2 },
  divider: { height: 1, backgroundColor: "#e5e5e5" },
  dividerDark: { backgroundColor: "#2a2a2a" },
  logoutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#fecaca",
    padding: 16,
    borderRadius: 12,
    marginTop: 32,
  },
  logoutButtonDark: { backgroundColor: "#1a0a0a", borderColor: "#3a1a1a" },
  logoutButtonText: { fontSize: 16, fontWeight: "600", color: "#ef4444" },
  loginButton: {
    backgroundColor: "#0a0a0a",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 24,
  },
  loginButtonDark: { backgroundColor: "#ffffff" },
  loginButtonText: { color: "#ffffff", fontWeight: "600" },
  loginButtonTextDark: { color: "#0a0a0a" },
})
