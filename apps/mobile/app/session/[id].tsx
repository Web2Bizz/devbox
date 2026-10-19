import { View, ActivityIndicator, KeyboardAvoidingView, Platform, useColorScheme } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTranslation } from "react-i18next"
import { SessionInfo, keyboardVerticalOffset } from "@web2bizz/ui-native"
import { useSessionBinding } from "@/lib/session-binding"
import { useSessionController } from "@/lib/use-session-screen"
import { SessionHeader } from "@/components/session/SessionHeader"
import { SessionBanners } from "@/components/session/SessionBanners"
import { MessageList } from "@/components/session/MessageList"
import { ComposerDock } from "@/components/session/ComposerDock"
import { PromptOverlay } from "@/components/session/PromptOverlay"
import { SessionSheets } from "@/components/session/SessionSheets"
import { s } from "./styles"

export default function SessionScreen() {
  const { id, directory, connectionId } = useLocalSearchParams<{
    id: string
    directory?: string
    connectionId?: string
  }>()
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()

  // Re-select on every focus, not just mount. currentSession/messages/
  // permissions are a single global store, and the native stack keeps screens
  // underneath a pushed one mounted. Without re-selecting on focus, navigating
  // to another session and back would leave this screen bound to the *other*
  // session's data (and its permission/question prompts) — so a user could
  // approve the wrong session's tool call. useFocusEffect re-binds this screen
  // to its own session whenever it becomes visible again.
  useSessionBinding(id, directory, connectionId)

  // Вся компоновка (composer, speech, мутации, outbox, slash, send, промпты)
  // живёт в контроллере — здесь только раскладка групп пропсов по виджетам.
  const c = useSessionController(t, isDark, insets)

  return (
    <>
      <SessionHeader {...c.header} />

      <KeyboardAvoidingView
        style={[s.container, isDark && s.containerDark]}
        // Both platforms use "padding" so the composer/toolbar is pushed up
        // above the keyboard via JS-measured keyboard height.
        //
        // Android previously relied on the native android:windowSoftInputMode
        // (adjustResize, see AndroidManifest.xml) with behavior={undefined}
        // to let the OS resize the window (see #70/#53). Since adopting
        // Expo's mandatory edge-to-edge display, Android no longer resizes
        // the window when the keyboard opens — the system assumes insets are
        // handled dynamically — so adjustResize became a no-op and the
        // bottom toolbar + input were left completely hidden behind the
        // keyboard (#147). "padding" restores avoidance without depending
        // on native resize.
        behavior="padding"
        keyboardVerticalOffset={keyboardVerticalOffset(Platform.OS, insets.top)}
      >
        {/* Session info pulldown */}
        <SessionInfo {...c.info} />

        <SessionBanners {...c.banners} />

        {c.isLoading ? (
          <View style={s.loading}>
            <ActivityIndicator size="large" color={isDark ? "#ffffff" : "#0a0a0a"} />
          </View>
        ) : (
          <MessageList {...c.list} />
        )}

        <ComposerDock
          {...c.dock}
          promptOverlay={c.hasActivePrompt ? <PromptOverlay {...c.prompts} /> : null}
        />
      </KeyboardAvoidingView>

      <SessionSheets {...c.sheets} />
    </>
  )
}
