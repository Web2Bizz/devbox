import { useState, useCallback, useEffect, useRef } from "react"
import { View, Text, Modal, TouchableOpacity, ActivityIndicator, AppState } from "react-native"
import { useFocusEffect } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { colors } from "@web2bizz/ui-native"
import { useConnections } from "../stores/connections"
import { useEvents } from "../stores/events"
import { HARDCODED_SERVER_URL } from "../lib/server-config"

// How often the badge re-validates the server health in the background, so
// the dot/text/ping stay fresh without reopening the modal. 30s is a single
// tiny GET with a 5s abort — negligible next to the always-on SSE stream.
const BADGE_PING_INTERVAL_MS = 30_000

type BadgeState = "connected" | "error" | "offline"

// Connection status badge for tab headers (projects, tasks, settings,
// account). Color and text always derive from the same `state`, so they can
// never disagree: green/Connected, red/Error, gray/Offline.
export function ConnectionBadge({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation()
  const activeConnection = useConnections((s) => s.activeConnection)
  const client = useConnections((s) => s.client)
  // Ping the ACTIVE server (LAN or cloud) — pinging the hardcoded URL while
  // a LAN connection is active showed the wrong server's latency/reachability.
  const serverBaseUrl = useConnections((s) => s.clientBase?.baseUrl)
  const authError = useEvents((s) => s.authError)
  const state: BadgeState = authError ? "error" : activeConnection && client ? "connected" : "offline"
  const [visible, setVisible] = useState(false)
  const [ping, setPing] = useState<number | null>(null)
  const [pingLoading, setPingLoading] = useState(false)
  const [pingError, setPingError] = useState<string | null>(null)
  const pingInFlight = useRef(false)

  const doPing = useCallback(async (quiet = false) => {
    if (pingInFlight.current) return
    pingInFlight.current = true
    if (!quiet) {
      setPingLoading(true)
      setPingError(null)
    }
    const start = Date.now()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${serverBaseUrl ?? HARDCODED_SERVER_URL}/global/health`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
      clearTimeout(timer)
      const elapsed = Date.now() - start
      // 401/403 means server reachable but auth required — still a successful ping
      if (!res.ok && res.status !== 401 && res.status !== 403) throw new Error(`HTTP ${res.status}`)
      setPing(elapsed)
      if (quiet) setPingError(null)
    } catch (e) {
      if (!quiet) setPingError(e instanceof Error ? e.message : String(e))
      setPing(null)
    } finally {
      pingInFlight.current = false
      if (!quiet) setPingLoading(false)
    }
  }, [serverBaseUrl])

  const open = useCallback(() => {
    setVisible(true)
    void doPing()
  }, [doPing])

  // Re-validate on every navigation focus (tab switches, stack pushes/pops
  // where the header badge shows) so the status is fresh immediately.
  // Interval + foreground re-validation below cover the stay-on-screen case.
  useFocusEffect(
    useCallback(() => {
      void doPing(true)
    }, [doPing]),
  )

  useEffect(() => {
    const id = setInterval(() => {
      void doPing(true)
    }, BADGE_PING_INTERVAL_MS)
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void doPing(true)
    })
    return () => {
      clearInterval(id)
      sub.remove()
    }
  }, [doPing])

  const label =
    state === "connected"
      ? t("common.connected")
      : state === "error"
        ? t("common.error")
        : t("common.offline")

  return (
    <>
      <TouchableOpacity
        onPress={open}
        activeOpacity={0.7}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          // NOTE: status-tint bg/border (#052e16/#dcfce7, #3f0a0a/#fef2f2,
          // #14532d/#bbf7d0, #7f1d1d/#fecaca) have no theme tokens — kept as-is.
          backgroundColor: isDark
            ? state === "connected"
              ? "#052e16"
              : state === "error"
                ? "#3f0a0a"
                : colors.surfaceDark
            : state === "connected"
              ? "#dcfce7"
              : state === "error"
                ? "#fef2f2"
                : colors.surfaceLight,
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: isDark
            ? state === "connected"
              ? "#14532d"
              : state === "error"
                ? "#7f1d1d"
                : colors.surfaceDark2
            : state === "connected"
              ? "#bbf7d0"
              : state === "error"
                ? "#fecaca"
                : colors.borderLight,
        }}
        testID="connection-status-badge"
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: state === "connected" ? colors.success : state === "error" ? colors.error : colors.textTertiaryLight,
          }}
        />
        <Text
          style={{
            fontSize: 12,
            fontWeight: "600",
            color: isDark
              ? state === "connected"
                ? "#4ade80"
                : state === "error"
                  ? "#f87171"
                  : colors.textSecondaryDark
              : state === "connected"
                ? "#15803d"
                : state === "error"
                  ? colors.errorStrong
                  : colors.textSecondaryLight,
          }}
        >
          {label}
        </Text>
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 24 }}
          activeOpacity={1}
          onPress={() => setVisible(false)}
        >
          <TouchableOpacity activeOpacity={1} style={{ width: "100%", maxWidth: 360 }}>
            <View
              style={{
                backgroundColor: isDark ? colors.surfaceDark : colors.white,
                borderRadius: 16,
                padding: 20,
                gap: 16,
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ fontSize: 18, fontWeight: "700", color: isDark ? colors.textPrimaryDark : colors.textPrimaryLight }}>
                  {t("connection.status.title")}
                </Text>
                <TouchableOpacity onPress={() => setVisible(false)} hitSlop={8}>
                  <Ionicons name="close" size={20} color={isDark ? colors.textSecondaryDark : colors.textSecondaryLight} />
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    backgroundColor: state === "connected" ? colors.success : state === "error" ? colors.error : colors.textTertiaryLight,
                  }}
                />
                <Text style={{ fontSize: 15, fontWeight: "600", color: isDark ? colors.textPrimaryDark : colors.textPrimaryLight }}>
                  {state === "connected"
                    ? t("connection.status.connected")
                    : state === "error"
                      ? t("connection.status.authError")
                      : t("connection.status.offline")}
                </Text>
              </View>

              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  backgroundColor: isDark ? colors.backgroundDark : colors.surfaceLight,
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Ionicons name="pulse-outline" size={18} color={isDark ? colors.textSecondaryDark : colors.textSecondaryLight} />
                  <Text style={{ fontSize: 14, color: isDark ? colors.textSecondaryDark : colors.textSecondaryLight }}>{t("connection.status.ping")}</Text>
                </View>
                {pingLoading ? (
                  <ActivityIndicator size="small" color={isDark ? colors.textPrimaryDark : colors.textPrimaryLight} />
                ) : ping !== null ? (
                  <Text style={{ fontSize: 14, fontWeight: "600", color: isDark ? colors.textPrimaryDark : colors.textPrimaryLight }}>{ping} ms</Text>
                ) : pingError ? (
                  <Text style={{ fontSize: 13, color: colors.error }}>{t("connection.status.unreachable")}</Text>
                ) : (
                  <Text style={{ fontSize: 13, color: colors.textSecondaryDark }}>—</Text>
                )}
              </View>

              <TouchableOpacity
                onPress={() => doPing()}
                disabled={pingLoading}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  backgroundColor: isDark ? colors.backgroundDark : colors.white,
                  borderWidth: 1,
                  borderColor: isDark ? colors.surfaceDark2 : colors.borderLight,
                  padding: 12,
                  borderRadius: 10,
                }}
              >
                <Ionicons name="refresh" size={16} color={isDark ? colors.textPrimaryDark : colors.textPrimaryLight} />
                <Text style={{ fontSize: 14, fontWeight: "600", color: isDark ? colors.textPrimaryDark : colors.textPrimaryLight }}>
                  {t("connection.status.refresh")}
                </Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  )
}
