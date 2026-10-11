import { useEffect, useState } from "react"
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native"
import { router } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { SvgXml } from "react-native-svg"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useConnections } from "../src/stores/connections"
import { useSettings } from "../src/stores/settings"
import { useEvents } from "../src/stores/events"
import { LanDiscoveryModal } from "@web2bizz/ui-native"
import type { LanCandidate } from "@web2bizz/ui-native"
import type { ServerConnection } from "../src/lib/types"
import { HARDCODED_SERVER_URL } from "../src/lib/server-config"

const logoXml = `<svg width="1672" height="200" viewBox="0 0 1672 200" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M360 40V59.2L400 99.2V160L360 200H280V160H360V120L320 80V40H280V0H320L360 40Z" fill="#F8FAFF"/><path d="M200 72L160 112V200H120V91.2L160 51.2V0H200V72Z" fill="url(#paint0_linear_33_49)"/><path d="M280 108.8L240 148.8V200H200V128L240 88V0H280V108.8Z" fill="url(#paint1_linear_33_49)"/><path d="M80 60.8L40 100.8V160H120V200H40L0 160V80L80 0V60.8Z" fill="#F8FAFF"/><path d="M542.49 199.172L500 52.9655H540.007L567.874 153.655H570.081L599.604 52.9655H630.781L660.58 153.655H662.235L690.102 52.9655H730.661L688.171 199.172H644.301L615.882 105.103H614.779L586.36 199.172H542.49Z" fill="white"/><path d="M808.866 200C763.893 200 728.852 173.793 729.68 124.966C729.956 80 761.41 51.5862 805.004 51.8621C855.219 52.4138 875.637 89.3793 874.257 131.862V140.138H769.135C770.791 160 789.553 168.276 810.798 168.552C826.801 168.552 846.39 164.69 857.151 160.276L866.532 189.793C851.908 196.966 830.663 200 808.866 200ZM769.411 110.069H836.457C833.422 92.1379 821.007 83.0345 803.348 83.0345C785.69 83.3104 771.619 92.1379 769.411 110.069Z" fill="white"/><path d="M960.399 199.724C948.259 199.724 930.601 196.69 920.668 188.414L916.806 199.172H888.387V5.79311H927.29V57.931C937.499 54.069 950.467 51.8621 961.227 51.8621C1005.65 51.8621 1036.55 80 1036.55 124.966C1036.55 170.207 1004.27 199.724 960.399 199.724ZM960.399 169.103C985.783 169.103 997.647 149.241 997.647 124.966C997.647 96.8276 982.748 84.6897 963.434 83.8621C951.57 83.0345 936.395 86.069 927.29 94.3448V156.138C935.292 164.414 949.087 169.103 960.399 169.103Z" fill="white"/><path d="M1045.23 199.172V170.207C1071.17 146.759 1132.69 100.966 1132.97 63.1724C1133.25 46.3448 1120 40.2759 1104.55 40C1087.72 38.8966 1067.3 45.2414 1057.1 50.4828L1042.2 19.8621C1060.13 10.7586 1083.31 5.24139 1105.66 5.24139C1141.8 5.51725 1175.46 20.9655 1175.18 63.1724C1174.91 102.897 1131.04 139.31 1101.79 163.586H1177.67V199.172H1045.23Z" fill="white"/><path d="M1263.56 199.724C1251.42 199.724 1233.76 196.69 1223.82 188.414L1219.96 199.172H1191.54V5.79311H1230.45V57.931C1240.66 54.069 1253.62 51.8621 1264.38 51.8621C1308.8 51.8621 1339.71 80 1339.71 124.966C1339.71 170.207 1307.43 199.724 1263.56 199.724ZM1263.56 169.103C1288.94 169.103 1300.8 149.241 1300.8 124.966C1300.8 96.8276 1285.9 84.6897 1266.59 83.8621C1254.73 83.0345 1239.55 86.069 1230.45 94.3448V156.138C1238.45 164.414 1252.24 169.103 1263.56 169.103Z" fill="white"/><path d="M1356.66 199.172V52.9655H1395.57V199.172H1356.66ZM1376.25 43.8621C1364.39 43.8621 1353.63 35.3103 1353.63 22.069C1353.63 8.55173 1364.39 0 1376.25 0C1387.29 0 1398.33 8.55173 1398.33 22.069C1398.33 35.3103 1387.29 43.8621 1376.25 43.8621Z" fill="white"/><path d="M1412.12 199.172V169.655L1487.17 84.6897H1412.12V52.9655H1537.94V81.3793L1462.06 166.897H1537.94V199.172H1412.12Z" fill="white"/><path d="M1546.18 199.172V169.655L1621.23 84.6897H1546.18V52.9655H1672V81.3793L1596.12 166.897H1672V199.172H1546.18Z" fill="white"/><defs><linearGradient id="paint0_linear_33_49" x1="200" y1="-17.0667" x2="200" y2="221.867" gradientUnits="userSpaceOnUse"><stop stop-color="#25CD94"/><stop offset="1" stop-color="#188AFF"/></linearGradient><linearGradient id="paint1_linear_33_49" x1="200" y1="-17.0667" x2="200" y2="221.867" gradientUnits="userSpaceOnUse"><stop stop-color="#25CD94"/><stop offset="1" stop-color="#188AFF"/></linearGradient></defs></svg>`

const lockXml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%"><defs><linearGradient id="devboxGradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#FF2A7A"/><stop offset="50%" stop-color="#FF5E62"/><stop offset="100%" stop-color="#FF9966"/></linearGradient><filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#FF2A7A" flood-opacity="0.25"/></filter></defs><g filter="url(#glow)"><path d="M 256,64 L 432,160 V 352 L 256,448 L 80,352 V 160 Z" fill="none" stroke="url(#devboxGradient)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/><path d="M 160,168 L 224,208 L 160,248" fill="none" stroke="url(#devboxGradient)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`

export default function LoginScreen() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()

  const { activeConnection, addConnection, updateConnection, testConnection } = useConnections()
  const authError = useEvents((s) => s.authError)
  const lanDiscovery = useSettings((s) => s.lanDiscovery)
  const setLanDiscovery = useSettings((s) => s.setLanDiscovery)
  const [lanVisible, setLanVisible] = useState(false)
  // Entry choice: cloud account (hardcoded server) vs a LAN server. Defaults
  // to whichever kind is currently active, so returning users land where
  // they left off.
  const [entryMode, setEntryMode] = useState<"account" | "local">(
    activeConnection?.discoveredOnLan ? "local" : "account",
  )

  const [username, setUsername] = useState(activeConnection?.username || "")
  const [password, setPassword] = useState("")
  const [isLoggingIn, setIsLoggingIn] = useState(false)

  useEffect(() => {
    if (activeConnection?.username) setUsername(activeConnection.username)
  }, [activeConnection?.username])

  // LAN discovery pick: the found server becomes a SECOND connection entry
  // (the hardcoded main server stays untouched). Login continues below with
  // the usual username/password against the now-active LAN connection.
  const handlePickLan = async (candidate: LanCandidate) => {
    const store = useConnections.getState()
    const existing = store.connections.find((c) => c.discoveredOnLan && c.url === candidate.url)
    const id = existing ? existing.id : await store.addLanConnection(candidate.url, `LAN · ${candidate.host}`)
    await store.setActiveConnection(id)
    setLanVisible(false)
  }

  // Discovery entry point: the tap itself is consent, so it enables the
  // setting on the fly instead of forcing a detour through Settings first.
  const handleFindLan = async () => {
    if (!lanDiscovery) await setLanDiscovery(true)
    setLanVisible(true)
  }
  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      Alert.alert("Ошибка", "Введите логин и пароль")
      return
    }
    setIsLoggingIn(true)
    try {
      const store = useConnections.getState()
      if (entryMode === "account") {
        // Account mode always targets the hardcoded main server, even when a
        // LAN connection is currently active — the two live side by side.
        let main: ServerConnection | null = store.connections.find((c) => !c.discoveredOnLan) ?? null
        if (!main) {
          const result = await testConnection(
            {
              id: "",
              name: "Основной сервер",
              type: "cloud",
              url: HARDCODED_SERVER_URL,
              username: username.trim(),
            },
            password,
          )
          if (!result.ok) throw new Error(result.error || "Connection failed")
          await addConnection(
            {
              name: "Основной сервер",
              type: "cloud",
              url: HARDCODED_SERVER_URL,
              username: username.trim(),
            },
            password,
          )
          main = useConnections.getState().connections.find((c) => !c.discoveredOnLan) ?? null
          if (main && useConnections.getState().activeConnection?.id !== main.id) {
            await store.setActiveConnection(main.id)
          }
        } else {
          if (store.activeConnection?.id !== main.id) await store.setActiveConnection(main.id)
          const result = await testConnection({ ...main, username: username.trim() }, password)
          if (!result.ok) throw new Error(result.error || "Connection failed")
          await updateConnection(main.id, { username: username.trim() }, password)
          useEvents.getState().connect()
        }
      } else {
        // Local mode: the form below only renders while a LAN connection is
        // active, so this is always a credentials update on that entry.
        const lan = store.activeConnection
        if (!lan?.discoveredOnLan) throw new Error("No local server selected")
        const result = await testConnection({ ...lan, username: username.trim() }, password)
        if (!result.ok) throw new Error(result.error || "Connection failed")
        await updateConnection(lan.id, { username: username.trim() }, password)
        useEvents.getState().connect()
      }
      setPassword("")
      router.replace("/(tabs)")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      Alert.alert("Ошибка подключения", msg)
    } finally {
      setIsLoggingIn(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, isDark && styles.containerDark]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <SvgXml xml={lockXml} width={83} height={83} />
          <Text style={[styles.title, isDark && styles.textDark]}>Вход</Text>
          <Text style={[styles.subtitle, isDark && styles.subtitleDark]}>Введите логин и пароль</Text>
          {authError ? (
            <Text style={styles.authErrorText} testID="login-auth-error">
              Ошибка авторизации — проверьте логин и пароль
            </Text>
          ) : null}
        </View>

        <View style={styles.formWrap}>
          {/* Entry choice: cloud account vs a LAN server */}
          <View style={[styles.modeSwitch, isDark && styles.modeSwitchDark]}>
            {(["account", "local"] as const).map((mode) => {
              const selected = entryMode === mode
              return (
                <TouchableOpacity
                  key={mode}
                  style={[styles.modeOption, selected && styles.modeOptionActive, selected && isDark && styles.modeOptionActiveDark]}
                  onPress={() => setEntryMode(mode)}
                  testID={`login-mode-${mode}`}
                >
                  <Text
                    style={[styles.modeOptionText, selected && styles.modeOptionTextActive, selected && isDark && styles.modeOptionTextActiveDark]}
                  >
                    {t(mode === "account" ? "lan.entryAccount" : "lan.entryLocal")}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {entryMode === "local" &&
            (activeConnection?.discoveredOnLan ? (
              <>
                <View style={[styles.serverBox, isDark && styles.serverBoxDark]}>
                  <Ionicons name="wifi" size={16} color={isDark ? "#888888" : "#666666"} />
                  <Text style={styles.serverText} numberOfLines={1}>
                    {activeConnection.url}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.lanButton, isDark && styles.lanButtonDark]}
                  onPress={handleFindLan}
                  testID="login-lan-find-another"
                >
                  <Ionicons name="search-outline" size={20} color={isDark ? "#ffffff" : "#0a0a0a"} />
                  <Text style={[styles.lanButtonText, isDark && styles.textDark]}>{t("lan.findAnother")}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={[styles.subtitle, isDark && styles.subtitleDark]}>{t("lan.localHint")}</Text>
                <TouchableOpacity
                  style={[styles.lanButton, isDark && styles.lanButtonDark]}
                  onPress={handleFindLan}
                  testID="login-lan-find-button"
                >
                  <Ionicons name="wifi-outline" size={20} color={isDark ? "#ffffff" : "#0a0a0a"} />
                  <Text style={[styles.lanButtonText, isDark && styles.textDark]}>{t("lan.findButton")}</Text>
                </TouchableOpacity>
              </>
            ))}

          {(entryMode === "account" || activeConnection?.discoveredOnLan) && (
            <>
              <Text style={[styles.label, isDark && styles.labelDark]}>Логин</Text>
          <TextInput
            style={[styles.input, isDark && styles.inputDark]}
            placeholder="username"
            placeholderTextColor={isDark ? "#666666" : "#999999"}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            testID="login-username-input"
          />

          <Text style={[styles.label, isDark && styles.labelDark]}>Пароль</Text>
          <TextInput
            style={[styles.input, isDark && styles.inputDark]}
            placeholder="••••••••"
            placeholderTextColor={isDark ? "#666666" : "#999999"}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            testID="login-password-input"
          />

          <TouchableOpacity
            style={[styles.loginButton, isDark && styles.loginButtonDark]}
            onPress={handleLogin}
            disabled={isLoggingIn}
            testID="login-button"
          >
            {isLoggingIn ? (
              <ActivityIndicator size="small" color={isDark ? "#0a0a0a" : "#ffffff"} />
            ) : (
              <>
                <Ionicons name="log-in-outline" size={20} color={isDark ? "#0a0a0a" : "#ffffff"} />
                <Text style={[styles.loginButtonText, isDark && styles.loginButtonTextDark]}>Войти</Text>
              </>
            )}
          </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
      <LanDiscoveryModal visible={lanVisible} onClose={() => setLanVisible(false)} onPick={handlePickLan} />
      <View style={[styles.footer, { paddingBottom: Math.max(8, insets.bottom) }]}>
        <SvgXml xml={logoXml} width={178} height={21} />
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  content: { flexGrow: 1, justifyContent: "center", padding: 24 },
  formWrap: { width: "100%", maxWidth: 500, alignSelf: "center" },
  header: { alignItems: "center", marginBottom: 32 },
  title: { fontSize: 28, fontWeight: "700", color: "#0a0a0a", marginTop: 16 },
  textDark: { color: "#ffffff" },
  subtitle: { fontSize: 14, color: "#666666", marginTop: 8, textAlign: "center" },
  subtitleDark: { color: "#888888" },
  authErrorText: { fontSize: 13, color: "#ef4444", marginTop: 12, textAlign: "center" },
  serverBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f5f5f5",
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  serverBoxDark: { backgroundColor: "#1a1a1a" },
  serverText: { fontSize: 13, color: "#666666", flex: 1 },
  label: { fontSize: 14, fontWeight: "600", color: "#0a0a0a", marginTop: 16, marginBottom: 8 },
  labelDark: { color: "#ffffff" },
  input: {
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: "#0a0a0a",
  },
  inputDark: { backgroundColor: "#1a1a1a", color: "#ffffff" },
  loginButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#0a0a0a",
    padding: 16,
    borderRadius: 12,
    marginTop: 24,
  },
  loginButtonDark: { backgroundColor: "#ffffff" },
  loginButtonText: { fontSize: 16, fontWeight: "600", color: "#ffffff" },
  loginButtonTextDark: { color: "#0a0a0a" },
  lanButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#e5e5e5",
    padding: 16,
    borderRadius: 12,
    marginTop: 12,
  },
  lanButtonDark: { borderColor: "#2a2a2a" },
  lanButtonText: { fontSize: 15, fontWeight: "600", color: "#0a0a0a" },
  modeSwitch: {
    flexDirection: "row",
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 4,
    gap: 4,
    marginBottom: 8,
  },
  modeSwitchDark: { backgroundColor: "#1a1a1a" },
  modeOption: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 8,
  },
  modeOptionActive: { backgroundColor: "#0a0a0a" },
  modeOptionActiveDark: { backgroundColor: "#ffffff" },
  modeOptionText: { fontSize: 14, fontWeight: "600", color: "#666666" },
  modeOptionTextActive: { color: "#ffffff" },
  modeOptionTextActiveDark: { color: "#0a0a0a" },
  footer: {
    height: 60,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0a0a0a",
  },
})
