import { useCallback, useEffect, useRef, useState } from "react"
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  useColorScheme,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import * as Network from "expo-network"
import { colors } from "../theme"
// NOTE: lib/lan-discover is not vendored into uikit yet (cards 3-5).
// Resolves once `src/lib` moves under `packages/uikit/src/lib`.
import {
  DEFAULT_LAN_PORTS,
  hostsInSubnet24,
  isPrivateLanIpv4,
  scanLanHosts,
  type LanCandidate,
} from "../utils/lan-discover"

// Modal that sweeps the local /24 for opencode servers. Rendered (but hidden)
// only when the user enabled settings.lanDiscovery — the sweep itself starts
// on open and aborts on close/unmount. A hit becomes a SECOND connection
// entry via onPick (the hardcoded main server is untouched).
// Pure atom — no zustand stores, only lib/lan-discover + expo-network.
export function LanDiscoveryModal({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean
  onClose: () => void
  onPick: (candidate: LanCandidate) => void
}) {
  const isDark = useColorScheme() === "dark"
  const { t } = useTranslation()
  const [phase, setPhase] = useState<"idle" | "scanning" | "done" | "error">("idle")
  const [errorText, setErrorText] = useState<string | null>(null)
  const [scanned, setScanned] = useState(0)
  const [total, setTotal] = useState(0)
  const [found, setFound] = useState<LanCandidate[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const start = useCallback(async () => {
    stop()
    setFound([])
    setScanned(0)
    setTotal(0)
    setErrorText(null)
    setPhase("scanning")
    const controller = new AbortController()
    abortRef.current = controller
    try {
      // Triggers the OS local-network permission prompt on first use (the
      // purpose string is in app.json) — hence only called from this
      // user-initiated flow, never at launch.
      const ownIp = await Network.getIpAddressAsync()
      if (controller.signal.aborted) return
      if (!ownIp || !isPrivateLanIpv4(ownIp)) {
        setPhase("error")
        setErrorText(t("lan.notOnLan"))
        return
      }
      const hosts = hostsInSubnet24(ownIp)
      const ports = [...DEFAULT_LAN_PORTS]
      setTotal(hosts.length * ports.length)
      for (let pi = 0; pi < ports.length; pi++) {
        if (controller.signal.aborted) break
        const base = pi * hosts.length
        await scanLanHosts(hosts, ports[pi], {
          signal: controller.signal,
          onCandidate: (c) =>
            setFound((prev) => (prev.some((p) => p.url === c.url) ? prev : [...prev, c])),
          onProgress: (s) => setScanned(base + s),
        })
      }
      if (!controller.signal.aborted) setPhase("done")
    } catch {
      if (!controller.signal.aborted) {
        setPhase("error")
        setErrorText(t("lan.unavailable"))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [stop, t])

  useEffect(() => {
    if (visible) void start()
    else stop()
    return () => stop()
  }, [visible, start, stop])

  const scanning = phase === "scanning"

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} testID="lan-scan-modal">
      <View
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 24 }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 400,
            maxHeight: "80%",
            backgroundColor: isDark ? colors.surfaceDark : colors.white,
            borderRadius: 16,
            padding: 20,
            gap: 12,
          }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: isDark ? colors.textPrimaryDark : colors.textPrimaryLight }}>
              {t("lan.scanTitle")}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={20} color={isDark ? colors.textSecondaryDark : colors.textSecondaryLight} />
            </TouchableOpacity>
          </View>

          {scanning ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ActivityIndicator size="small" color={isDark ? colors.textPrimaryDark : colors.textPrimaryLight} />
              <Text style={{ fontSize: 14, color: isDark ? colors.textSecondaryDark : colors.textSecondaryLight }}>
                {t("lan.scanning", { scanned, total })}
              </Text>
            </View>
          ) : phase === "error" ? (
            <Text style={{ fontSize: 14, color: colors.error }}>{errorText}</Text>
          ) : found.length === 0 ? (
            <Text style={{ fontSize: 14, color: isDark ? colors.textSecondaryDark : colors.textSecondaryLight }}>{t("lan.none")}</Text>
          ) : null}

          <FlatList
            data={found}
            keyExtractor={(item) => item.url}
            renderItem={({ item, index }) => (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  backgroundColor: isDark ? colors.backgroundDark : colors.surfaceLight,
                  borderRadius: 10,
                  padding: 12,
                }}
                testID={`lan-candidate-${index}`}
              >
                <Ionicons name="server-outline" size={20} color={isDark ? colors.textSecondaryDark : colors.textSecondaryLight} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: isDark ? colors.textPrimaryDark : colors.textPrimaryLight }} numberOfLines={1}>
                    {item.host}:{item.port}
                  </Text>
                  <Text style={{ fontSize: 12, color: isDark ? colors.textSecondaryDark : colors.textSecondaryLight }} numberOfLines={1}>
                    {item.version ? `v${item.version}` : item.authRequired ? t("lan.needsLogin") : item.url}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => onPick(item)}
                  style={{
                    backgroundColor: colors.backgroundDark,
                    borderRadius: 8,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                  }}
                  testID={`lan-use-${index}`}
                >
                  <Text style={{ fontSize: 14, fontWeight: "600", color: colors.white }}>{t("lan.use")}</Text>
                </TouchableOpacity>
              </View>
            )}
            contentContainerStyle={{ gap: 8 }}
          />

          <View style={{ flexDirection: "row", gap: 8 }}>
            {scanning ? (
              <TouchableOpacity
                onPress={() => {
                  stop()
                  setPhase("done")
                }}
                style={{
                  flex: 1,
                  alignItems: "center",
                  borderWidth: 1,
                  borderColor: isDark ? colors.surfaceDark2 : colors.borderLight,
                  padding: 12,
                  borderRadius: 10,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "600", color: isDark ? colors.textPrimaryDark : colors.textPrimaryLight }}>
                  {t("lan.stop")}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={() => start()}
                style={{
                  flex: 1,
                  alignItems: "center",
                  borderWidth: 1,
                  borderColor: isDark ? colors.surfaceDark2 : colors.borderLight,
                  padding: 12,
                  borderRadius: 10,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "600", color: isDark ? colors.textPrimaryDark : colors.textPrimaryLight }}>
                  {t("lan.rescan")}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Modal>
  )
}
