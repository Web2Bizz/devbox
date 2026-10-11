import { useCallback, useMemo, useState } from "react"
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, useColorScheme } from "react-native"
import { Stack, useRouter } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { MessageBubble, PermissionPrompt } from "@web2bizz/ui-native"
import { buildDemoScript, buildDemoCompletionMessage, buildDemoDenialMessage } from "../src/lib/demo-script"
import { colors } from "@web2bizz/ui-native"

// Reply values of PermissionPrompt's `onReply` (see
// packages/uikit/src/components/chat/PermissionPrompt.tsx).
type DemoPermissionReply = "once" | "always" | "reject"

// Fully offline, scripted walkthrough for installers with no self-hosted
// devbox server. ISOLATION: every message/part below is hardcoded local
// data built once with useMemo — this screen never calls useSessions,
// useConnections, useEvents, or any sdk.ts client method, so it cannot
// create a real session, touch the network, or corrupt real app state. The
// permission "reply" only flips local component state (below); it never
// calls sessionClient.permission.reply the way app/session/[id].tsx does.
export default function DemoScreen() {
  const router = useRouter()
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()

  // Built once per mount from pure, hardcoded data (src/lib/demo-script.ts).
  const script = useMemo(() => buildDemoScript(), [])
  const [reply, setReply] = useState<DemoPermissionReply | null>(null)

  const handleReply = useCallback((r: DemoPermissionReply) => {
    setReply(r)
  }, [])

  const handleConnectPress = useCallback(() => {
    router.push("/connection/add")
  }, [router])

  const completion = useMemo(() => {
    if (!reply) return null
    return reply === "reject" ? buildDemoDenialMessage() : buildDemoCompletionMessage()
  }, [reply])

  const [userMessage, assistantMessage] = script.messages

  return (
    <>
      <Stack.Screen options={{ title: t("demo.title"), presentation: "card" }} />
      <View style={[s.container, isDark && s.containerDark]} testID="demo-screen">
        <View style={[s.banner, isDark && s.bannerDark]} testID="demo-banner">
          <Ionicons name="play-circle-outline" size={16} color={colors.accent} />
          <Text style={s.bannerText}>{t("demo.banner")}</Text>
        </View>

        <ScrollView contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
          <MessageBubble message={userMessage} parts={script.parts[userMessage.id] || []} isDark={isDark} />
          <MessageBubble message={assistantMessage} parts={script.parts[assistantMessage.id] || []} isDark={isDark} />

          {!reply && <PermissionPrompt permission={script.permission} isDark={isDark} onReply={handleReply} />}

          {completion && (
            <MessageBubble message={completion.message} parts={completion.parts} isDark={isDark} />
          )}

          <View style={[s.ctaCard, isDark && s.ctaCardDark]} testID="demo-cta-card">
            <Text style={[s.ctaTitle, isDark && s.textWhite]}>{t("demo.ctaTitle")}</Text>
            <Text style={[s.ctaSubtitle, isDark && s.metaDark]}>{t("demo.ctaSubtitle")}</Text>
            <TouchableOpacity
              style={s.connectButton}
              onPress={handleConnectPress}
              testID="demo-connect-button"
            >
              <Text style={s.connectButtonText}>{t("demo.connectButton")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.hostedCtaLink}
              onPress={handleConnectPress}
              testID="demo-hosted-cta"
            >
              <Text style={s.hostedCtaLinkText}>{t("demo.hostedCtaLink")}</Text>
            </TouchableOpacity>
            {/* Setup guide link removed */}
          </View>
        </ScrollView>
      </View>
    </>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  textWhite: { color: "#ffffff" },
  metaDark: { color: "#888888" },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.accentMuted,
    borderBottomWidth: 1,
    borderBottomColor: colors.accentBorder,
  },
  bannerDark: { backgroundColor: colors.accentBannerDark, borderBottomColor: colors.accentBorderDark },
  bannerText: { fontSize: 13, fontWeight: "600", color: colors.accentStrong, flex: 1 },

  scrollContent: { padding: 16, paddingBottom: 40 },

  ctaCard: {
    marginTop: 8,
    padding: 20,
    borderRadius: 16,
    backgroundColor: "#f5f5f5",
    alignItems: "center",
  },
  ctaCardDark: { backgroundColor: "#1a1a1a" },
  ctaTitle: { fontSize: 17, fontWeight: "700", color: "#0a0a0a", textAlign: "center" },
  ctaSubtitle: { fontSize: 13, color: "#666666", marginTop: 6, textAlign: "center", lineHeight: 18 },
  connectButton: {
    marginTop: 16,
    backgroundColor: "#0a0a0a",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    width: "100%",
    alignItems: "center",
  },
  connectButtonText: { color: "#ffffff", fontWeight: "600", fontSize: 15 },
  hostedCtaLink: { marginTop: 14 },
  hostedCtaLinkText: { fontSize: 14, fontWeight: "600", color: colors.accent, textAlign: "center" },
  setupGuideLink: { marginTop: 14 },
  setupGuideLinkText: { fontSize: 14, fontWeight: "600", color: colors.accent },
})
