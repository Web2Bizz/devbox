/**
 * "A newer version exists" — the only way a sideloaded install ever learns that.
 *
 * Deliberately not a modal: a modal on launch is the fastest way to get an app
 * uninstalled, and this must be safe to ship to the whole install base. It is a
 * single dismissible strip above the session list, with a "Not now" that sticks
 * for that version (see update-check-policy.ts).
 *
 * Renders nothing at all when there is no update, when the check failed, on
 * iOS, or once dismissed — so the common case costs one hook and no pixels.
 */

import { useCallback, useEffect, useState } from "react"
import { View, Text, TouchableOpacity, StyleSheet, Linking } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { colors } from "@web2bizz/ui-native"
import { checkForUpdate, dismissUpdate, CURRENT_VERSION, type AvailableUpdate } from "../lib/update-check"

export function UpdateBanner({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation()
  const [update, setUpdate] = useState<AvailableUpdate | null>(null)

  useEffect(() => {
    let cancelled = false
    checkForUpdate()
      .then((result) => {
        if (!cancelled) setUpdate(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const onDismiss = useCallback(() => {
    if (update) void dismissUpdate(update.version)
    setUpdate(null)
  }, [update])

  const onOpen = useCallback(() => {
    if (!update) return
    // Opening the release page is also an implicit "I've seen this version":
    // do not nag about it again either.
    void dismissUpdate(update.version)
    void Linking.openURL(update.url)
  }, [update])

  if (!update) return null

  return (
    <View style={[styles.banner, isDark && styles.bannerDark]} testID="update-banner">
      <Ionicons name="arrow-up-circle" size={20} color={isDark ? colors.accentPale : colors.accentStrong} />
      <View style={styles.text}>
        <Text style={[styles.title, isDark && styles.titleDark]}>{t("update.available")}</Text>
        <Text style={[styles.body, isDark && styles.bodyDark]} numberOfLines={1}>
          {t("update.body", { version: update.version, current: CURRENT_VERSION })}
        </Text>
      </View>
      <TouchableOpacity onPress={onOpen} testID="update-banner-open" hitSlop={8}>
        <Text style={[styles.action, isDark && styles.actionDark]}>{t("update.action")}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onDismiss} testID="update-banner-dismiss" hitSlop={8}>
        <Ionicons name="close" size={18} color={isDark ? "#888888" : "#666666"} />
      </TouchableOpacity>
    </View>
  )
}

// Banner follows the app accent (pink/orange from the icon gradient) via
// theme tokens — no raw sky/slate blues.
const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.accentMuted,
  },
  bannerDark: {
    backgroundColor: colors.accentMutedDark,
  },
  text: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.accentStrong,
  },
  titleDark: {
    color: "#FFE4D9",
  },
  body: {
    fontSize: 12,
    color: colors.accentStrong,
  },
  bodyDark: {
    color: colors.textSecondaryDark,
  },
  action: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.accentStrong,
  },
  actionDark: {
    color: colors.accentPale,
  },
})
