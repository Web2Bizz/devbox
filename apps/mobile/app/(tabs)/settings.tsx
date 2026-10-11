import { Fragment, useCallback, useState } from "react"
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  StyleSheet,
  useColorScheme,
  Alert,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { SvgXml } from "react-native-svg"
import { router } from "expo-router"
import { useAuth } from "../../src/stores/auth"
import { useSettings } from "../../src/stores/settings"
import { useConnections } from "../../src/stores/connections"
import { useEvents } from "../../src/stores/events"
import { LanDiscoveryModal } from "@web2bizz/ui-native"
import type { LanCandidate } from "@web2bizz/ui-native"
import type { ServerConnection } from "../../src/lib/types"

const logoXml = `<svg width="1672" height="200" viewBox="0 0 1672 200" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M360 40V59.2L400 99.2V160L360 200H280V160H360V120L320 80V40H280V0H320L360 40Z" fill="#F8FAFF"/><path d="M200 72L160 112V200H120V91.2L160 51.2V0H200V72Z" fill="url(#paint0_linear_33_49)"/><path d="M280 108.8L240 148.8V200H200V128L240 88V0H280V108.8Z" fill="url(#paint1_linear_33_49)"/><path d="M80 60.8L40 100.8V160H120V200H40L0 160V80L80 0V60.8Z" fill="#F8FAFF"/><path d="M542.49 199.172L500 52.9655H540.007L567.874 153.655H570.081L599.604 52.9655H630.781L660.58 153.655H662.235L690.102 52.9655H730.661L688.171 199.172H644.301L615.882 105.103H614.779L586.36 199.172H542.49Z" fill="white"/><path d="M808.866 200C763.893 200 728.852 173.793 729.68 124.966C729.956 80 761.41 51.5862 805.004 51.8621C855.219 52.4138 875.637 89.3793 874.257 131.862V140.138H769.135C770.791 160 789.553 168.276 810.798 168.552C826.801 168.552 846.39 164.69 857.151 160.276L866.532 189.793C851.908 196.966 830.663 200 808.866 200ZM769.411 110.069H836.457C833.422 92.1379 821.007 83.0345 803.348 83.0345C785.69 83.3104 771.619 92.1379 769.411 110.069Z" fill="white"/><path d="M960.399 199.724C948.259 199.724 930.601 196.69 920.668 188.414L916.806 199.172H888.387V5.79311H927.29V57.931C937.499 54.069 950.467 51.8621 961.227 51.8621C1005.65 51.8621 1036.55 80 1036.55 124.966C1036.55 170.207 1004.27 199.724 960.399 199.724ZM960.399 169.103C985.783 169.103 997.647 149.241 997.647 124.966C997.647 96.8276 982.748 84.6897 963.434 83.8621C951.57 83.0345 936.395 86.069 927.29 94.3448V156.138C935.292 164.414 949.087 169.103 960.399 169.103Z" fill="white"/><path d="M1045.23 199.172V170.207C1071.17 146.759 1132.69 100.966 1132.97 63.1724C1133.25 46.3448 1120 40.2759 1104.55 40C1087.72 38.8966 1067.3 45.2414 1057.1 50.4828L1042.2 19.8621C1060.13 10.7586 1083.31 5.24139 1105.66 5.24139C1141.8 5.51725 1175.46 20.9655 1175.18 63.1724C1174.91 102.897 1131.04 139.31 1101.79 163.586H1177.67V199.172H1045.23Z" fill="white"/><path d="M1263.56 199.724C1251.42 199.724 1233.76 196.69 1223.82 188.414L1219.96 199.172H1191.54V5.79311H1230.45V57.931C1240.66 54.069 1253.62 51.8621 1264.38 51.8621C1308.8 51.8621 1339.71 80 1339.71 124.966C1339.71 170.207 1307.43 199.724 1263.56 199.724ZM1263.56 169.103C1288.94 169.103 1300.8 149.241 1300.8 124.966C1300.8 96.8276 1285.9 84.6897 1266.59 83.8621C1254.73 83.0345 1239.55 86.069 1230.45 94.3448V156.138C1238.45 164.414 1252.24 169.103 1263.56 169.103Z" fill="white"/><path d="M1356.66 199.172V52.9655H1395.57V199.172H1356.66ZM1376.25 43.8621C1364.39 43.8621 1353.63 35.3103 1353.63 22.069C1353.63 8.55173 1364.39 0 1376.25 0C1387.29 0 1398.33 8.55173 1398.33 22.069C1398.33 35.3103 1387.29 43.8621 1376.25 43.8621Z" fill="white"/><path d="M1412.12 199.172V169.655L1487.17 84.6897H1412.12V52.9655H1537.94V81.3793L1462.06 166.897H1537.94V199.172H1412.12Z" fill="white"/><path d="M1546.18 199.172V169.655L1621.23 84.6897H1546.18V52.9655H1672V81.3793L1596.12 166.897H1672V199.172H1546.18Z" fill="white"/><defs><linearGradient id="paint0_linear_33_49" x1="200" y1="-17.0667" x2="200" y2="221.867" gradientUnits="userSpaceOnUse"><stop stop-color="#25CD94"/><stop offset="1" stop-color="#188AFF"/></linearGradient><linearGradient id="paint1_linear_33_49" x1="200" y1="-17.0667" x2="200" y2="221.867" gradientUnits="userSpaceOnUse"><stop stop-color="#25CD94"/><stop offset="1" stop-color="#188AFF"/></linearGradient></defs></svg>`
import {
  categories,
  categoryMeta,
  setup as setupNotifications,
  granted as notificationsGranted,
} from "../../src/lib/notifications"
import type { Category } from "../../src/lib/notifications"
import { CURRENT_VERSION } from "../../src/lib/update-check"
import { layout } from "@web2bizz/ui-native"
import type { LocalePreference } from "../../src/lib/i18n/locale-resolve"

function SettingRow({
  icon,
  label,
  description,
  isDark,
  right,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  description?: string
  isDark: boolean
  right?: React.ReactNode
  onPress?: () => void
}) {
  const content = (
    <View style={styles.settingRow}>
      <Ionicons name={icon} size={20} color={isDark ? "#888888" : "#666666"} />
      <View style={styles.settingContent}>
        <Text style={[styles.settingLabel, isDark && styles.textDark]}>{label}</Text>
        {description && <Text style={[styles.settingDescription, isDark && styles.metaDark]}>{description}</Text>}
      </View>
      {right}
    </View>
  )

  if (onPress) {
    return <TouchableOpacity onPress={onPress}>{content}</TouchableOpacity>
  }

  return content
}

function ServerRow({
  connection,
  isActive,
  needsLogin,
  isDark,
  onActivate,
}: {
  connection: ServerConnection
  isActive: boolean
  needsLogin: boolean
  isDark: boolean
  onActivate: () => void
}) {
  const { t } = useTranslation()
  // Subtitle under a server name: LAN entries show their address (needed to
  // tell several apart); the main server's domain is never shown. A pending
  // login warning takes precedence over both.
  const subtitle = needsLogin
    ? t("settings.servers.needsLogin")
    : connection.discoveredOnLan
      ? connection.url
      : undefined
  return (
    <View style={styles.serverRow}>
      <TouchableOpacity
        style={styles.serverMain}
        onPress={onActivate}
        disabled={isActive}
        testID={`server-row-${connection.id}`}
      >
        <Ionicons
          name={connection.discoveredOnLan ? "wifi" : "cloud-outline"}
          size={20}
          color={isDark ? "#888888" : "#666666"}
        />
        <View style={styles.settingContent}>
          <Text style={[styles.settingLabel, isDark && styles.textDark]} numberOfLines={1}>
            {connection.name}
          </Text>
          {subtitle && (
            <Text style={[styles.settingDescription, isDark && styles.metaDark]} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>
        {isActive && (
          <View style={[styles.activeBadge, isDark && styles.activeBadgeDark]}>
            <Text style={[styles.activeBadgeText, isDark && styles.activeBadgeTextDark]}>
              {t("settings.servers.active")}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    </View>
  )
}

export default function SettingsScreen() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()

  const { settings, hasBiometrics, updateSettings, lock } = useAuth()
  const { notifications, setNotification, locale, setLocale, lanDiscovery, setLanDiscovery } = useSettings()
  const { activeConnection, connections, logoutAll, setActiveConnection, addLanConnection } = useConnections()
  const unauthorized = useEvents((s) => s.unauthorizedConnections)
  const [lanVisible, setLanVisible] = useState(false)
  const [osGranted, setOsGranted] = useState<boolean | null>(null)

  // Check OS permission state on first toggle attempt
  const handleToggle = useCallback(
    async (category: Category, enabled: boolean) => {
      if (enabled) {
        const ok = await setupNotifications()
        setOsGranted(ok)
        if (!ok) {
          Alert.alert(t("settings.alerts.notificationsDisabledTitle"), t("settings.alerts.notificationsDisabledMessage"))
          return
        }
      }
      setNotification(category, enabled)
    },
    [setNotification, t],
  )

  // Lazy-check OS permission for status display
  if (osGranted === null) {
    notificationsGranted()
      .then(setOsGranted)
      .catch(() => setOsGranted(false))
  }

  const localeLabels: Record<LocalePreference, string> = {
    system: t("settings.language.system"),
    en: t("settings.language.en"),
    ru: t("settings.language.ru"),
  }

  const handleLanguagePress = useCallback(() => {
    Alert.alert(t("settings.language.title"), undefined, [
      { text: localeLabels.system, onPress: () => setLocale("system") },
      { text: localeLabels.en, onPress: () => setLocale("en") },
      { text: localeLabels.ru, onPress: () => setLocale("ru") },
      { text: t("common.cancel"), style: "cancel" },
    ])
  }, [t, setLocale, localeLabels])

  const handleLogout = useCallback(() => {
    Alert.alert(t("settings.logout.confirmTitle"), t("settings.logout.confirmMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.logout.button"),
        style: "destructive",
        onPress: async () => {
          // Same full logout as the account screen — lands on login, never
          // bounces back via a leftover second connection.
          await logoutAll()
          router.replace("/login")
        },
      },
    ])
  }, [logoutAll, t])

  // LAN discovery pick from settings: same scenario as the login page —
  // the found server is added as a second entry. Credentials are entered on
  // the login screen (local mode) — there is no connection editing UI.
  const handlePickLan = useCallback(
    async (candidate: LanCandidate) => {
      const store = useConnections.getState()
      const existing = store.connections.find((c) => c.discoveredOnLan && c.url === candidate.url)
      if (!existing) await store.addLanConnection(candidate.url, `LAN · ${candidate.host}`)
      setLanVisible(false)
    },
    [],
  )

  const handleActivate = useCallback(
    (id: string) => {
      void useConnections.getState().setActiveConnection(id)
    },
    [],
  )

  const mainConnections = connections.filter((c) => !c.discoveredOnLan)
  const lanConnections = connections.filter((c) => c.discoveredOnLan)

  // Security rows live in their own section below; everything else stays in
  // the main card.
  const securityRows: React.ReactNode[] = [
    <SettingRow
      key="biometric-open"
      icon="finger-print"
      label={t("settings.security.biometricOpen.label")}
      description={
        hasBiometrics
          ? t("settings.security.biometricOpen.descriptionEnabled")
          : t("settings.security.biometricOpen.descriptionUnavailable")
      }
      isDark={isDark}
      right={
        <Switch
          value={settings.requireBiometric}
          onValueChange={(value) => updateSettings({ requireBiometric: value })}
          disabled={!hasBiometrics}
          trackColor={{ false: "#767577", true: "#22c55e" }}
        />
      }
    />,
    <SettingRow
      key="biometric-send"
      icon="lock-closed"
      label={t("settings.security.biometricSend.label")}
      description={t("settings.security.biometricSend.description")}
      isDark={isDark}
      right={
        <Switch
          value={settings.requireBiometricForMessages}
          onValueChange={(value) => updateSettings({ requireBiometricForMessages: value })}
          disabled={!hasBiometrics || !settings.requireBiometric}
          trackColor={{ false: "#767577", true: "#22c55e" }}
        />
      }
    />,
    ...(settings.requireBiometric
      ? [
          <SettingRow
            key="lock-now"
            icon="exit"
            label={t("settings.security.lockNow.label")}
            description={t("settings.security.lockNow.description")}
            isDark={isDark}
            onPress={lock}
            right={<Ionicons name="chevron-forward" size={20} color={isDark ? "#666666" : "#999999"} />}
          />,
        ]
      : []),
  ]

  // All settings as a single profile-style card list with dividers
  const rows: React.ReactNode[] = [
    ...categories.map((category) => {
      const meta = categoryMeta[category]
      return (
        <SettingRow
          key={category}
          icon={meta.icon as keyof typeof Ionicons.glyphMap}
          label={t(meta.labelKey)}
          description={t(meta.descriptionKey)}
          isDark={isDark}
          right={
            <Switch
              value={notifications[category]}
              onValueChange={(value) => handleToggle(category, value)}
              trackColor={{ false: "#767577", true: "#22c55e" }}
            />
          }
        />
      )
    }),
    <SettingRow
      key="language"
      icon="language"
      label={t("settings.language.label")}
      description={localeLabels[locale]}
      isDark={isDark}
      onPress={handleLanguagePress}
      right={<Ionicons name="chevron-forward" size={20} color={isDark ? "#666666" : "#999999"} />}
    />,
    <SettingRow
      key="version"
      icon="information-circle"
      label={t("settings.about.version")}
      description={CURRENT_VERSION}
      isDark={isDark}
    />,
  ]

  return (
    <ScrollView style={[styles.container, isDark && styles.containerDark]} contentContainerStyle={styles.content}>
      <View style={[styles.card, isDark && styles.cardDark]}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && <View style={[styles.divider, isDark && styles.dividerDark]} />}
            {row}
          </Fragment>
        ))}
        {osGranted === false && (
          <>
            <View style={[styles.divider, isDark && styles.dividerDark]} />
            <Text style={[styles.settingDescription, { color: "#ef4444" }]}>
              {t("settings.notifications.disabledNotice")}
            </Text>
          </>
        )}
      </View>

      <Text style={[styles.sectionHeader, isDark && styles.textDark]}>{t("settings.sections.security")}</Text>
      <View style={[styles.card, isDark && styles.cardDark]}>
        {securityRows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && <View style={[styles.divider, isDark && styles.dividerDark]} />}
            {row}
          </Fragment>
        ))}
      </View>

      {/* Servers: main and LAN connections in one mixed list (like the
          settings rows above — no subdivisions). The LAN discovery toggle
          lives here too — it gates the discover button below. Tap a row to
          make it active; the pencil opens credentials. LAN entries are added
          via discovery (same flow as the login page). */}
      <Text style={[styles.sectionHeader, isDark && styles.textDark]}>{t("settings.sections.servers")}</Text>

      <View style={[styles.card, isDark && styles.cardDark]}>
        <SettingRow
          key="lan-discovery"
          icon="wifi"
          label={t("lan.settingsLabel")}
          description={t("lan.settingsDescription")}
          isDark={isDark}
          right={
            <Switch
              value={lanDiscovery}
              onValueChange={(value) => setLanDiscovery(value)}
              trackColor={{ false: "#767577", true: "#22c55e" }}
            />
          }
        />
        {[...mainConnections, ...lanConnections].map((c) => (
          <Fragment key={c.id}>
            <View style={[styles.divider, isDark && styles.dividerDark]} />
            <ServerRow
              connection={c}
              isActive={activeConnection?.id === c.id}
              needsLogin={unauthorized.includes(c.id)}
              isDark={isDark}
              onActivate={() => handleActivate(c.id)}
            />
          </Fragment>
        ))}
        <TouchableOpacity
          style={[styles.discoverButton, isDark && styles.discoverButtonDark]}
          onPress={() => setLanVisible(true)}
          disabled={!lanDiscovery}
          testID="settings-lan-discover-button"
        >
          <Ionicons
            name="wifi-outline"
            size={20}
            color={!lanDiscovery ? (isDark ? "#444444" : "#cccccc") : isDark ? "#ffffff" : "#0a0a0a"}
          />
          <Text
            style={[
              styles.discoverButtonText,
              isDark && styles.textDark,
              !lanDiscovery && styles.discoverButtonTextDisabled,
            ]}
          >
            {t("lan.findButton")}
          </Text>
        </TouchableOpacity>
      </View>
      <LanDiscoveryModal visible={lanVisible} onClose={() => setLanVisible(false)} onPick={handlePickLan} />

      {activeConnection && (
        <View style={styles.logoutContainer}>
          <TouchableOpacity
            style={[styles.logoutButton, isDark && styles.logoutButtonDark]}
            onPress={handleLogout}
            testID="logout-button"
          >
            <Ionicons name="log-out-outline" size={20} color="#ef4444" />
            <Text style={styles.logoutButtonText}>{t("settings.logout.button")}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.footer}>
        <View style={styles.footerLogoWrap}>
          <SvgXml xml={logoXml} width={140} height={17} />
        </View>
      </View>
    </ScrollView>
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
  content: {
    flexGrow: 1,
    // Horizontal insets follow the shared container token (16) so the card
    // list aligns with the header badge and the other tabs' lists — the old
    // hardcoded 24 made everything here 8pt narrower per side.
    paddingHorizontal: layout.containerPadding,
    paddingTop: 24,
    paddingBottom: 32,
    maxWidth: layout.contentMaxWidth,
    alignSelf: "center",
    width: "100%",
  },
  card: {
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  cardDark: { backgroundColor: "#1a1a1a" },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#0a0a0a",
    marginTop: 24,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  serverRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  serverMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
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
  discoverButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    padding: 12,
    borderRadius: 10,
    marginTop: 4,
  },
  discoverButtonDark: {
    borderColor: "#2a2a2a",
  },
  discoverButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  discoverButtonTextDisabled: {
    color: "#999999",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  divider: { height: 1, backgroundColor: "#e5e5e5" },
  dividerDark: { backgroundColor: "#2a2a2a" },
  settingContent: {
    flex: 1,
  },
  settingLabel: {
    fontSize: 16,
    color: "#0a0a0a",
  },
  textDark: {
    color: "#ffffff",
  },
  settingDescription: {
    fontSize: 13,
    color: "#666666",
    marginTop: 2,
  },
  metaDark: {
    color: "#888888",
  },
  logoutContainer: {
    marginTop: 24,
  },
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
  },
  logoutButtonDark: {
    backgroundColor: "#1a0a0a",
    borderColor: "#3a1a1a",
  },
  logoutButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#ef4444",
  },
  footer: {
    alignItems: "center",
    padding: 24,
  },
  footerLogoWrap: {
    backgroundColor: "#0a0a0a",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  footerText: {
    fontSize: 13,
    color: "#999999",
    textAlign: "center",
  },
})
