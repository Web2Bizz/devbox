import { Tabs } from "expo-router"
import { useColorScheme } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { useEvents } from "../../src/stores/events"
import { useSessions } from "../../src/stores/sessions"
import { useSessionsList } from "../../src/queries/sessions"
import { countActiveTasks } from "../../src/lib/active-tasks"
import { ConnectionBadge } from "../../src/components/ConnectionBadge"
import { layout } from "@web2bizz/ui-native"

export default function TabLayout() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()
  // Badge with the number of sessions where the agent is working right now.
  // Must use the same selector as the Tasks screen (loaded sessions ∩
  // busy|retry|sending) — counting raw sessionStatus entries diverges as soon
  // as one stale entry lingers (deleted session, missed idle event).
  const { data: sessions } = useSessionsList()
  const sessionStatus = useEvents((s) => s.sessionStatus)
  const sending = useSessions((s) => s.sending)
  const busyCount = countActiveTasks(sessions ?? [], sessionStatus, sending)

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: (isDark ? "#ffffff" : "#0a0a0a") as unknown as string,
        tabBarInactiveTintColor: (isDark ? "#666666" : "#999999") as unknown as string,
        tabBarStyle: {
          backgroundColor: isDark ? "#0a0a0a" : "#ffffff",
          borderTopColor: isDark ? "#1a1a1a" : "#e5e5e5",
        },
        headerStyle: {
          backgroundColor: isDark ? "#0a0a0a" : "#ffffff",
        },
        headerTintColor: (isDark ? "#ffffff" : "#0a0a0a") as unknown as string,
        // Badge должен следовать ширине контейнера: контент имеет
        // paddingHorizontal: layout.containerPadding (16), поэтому headerRight
        // выравнивается тем же токеном. headerLeftContainerStyle не трогаем —
        // пустой left-контейнер с paddingLeft сдвигает title вправо (двойной
        // отступ слева у заголовков, замеченный в ревью), title и так имеет
        // дефолтный отступ заголовка.
        headerRightContainerStyle: {
          paddingRight: layout.containerPadding,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("nav.projectsTab"),
          tabBarIcon: ({ color, size }) => <Ionicons name="folder-outline" size={size} color={color as unknown as string} />,
          headerRight: () => <ConnectionBadge isDark={isDark} />,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: t("nav.tasksTab"),
          tabBarIcon: ({ color, size }) => <Ionicons name="pulse-outline" size={size} color={color as unknown as string} />,
          tabBarBadge: busyCount > 0 ? busyCount : undefined,
          headerRight: () => <ConnectionBadge isDark={isDark} />,
        }}
      />
      <Tabs.Screen
        name="new-project"
        options={{
          title: t("nav.newProjectTab"),
          tabBarIcon: ({ color, size }) => <Ionicons name="add-circle-outline" size={size} color={color as unknown as string} />,
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault()
            // Open new project modal via global UI store — handled in index.tsx
            const { openNewProject } = require("../../src/stores/ui").useUi.getState()
            openNewProject()
          },
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t("nav.settingsTab"),
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color as unknown as string} />,
          headerRight: () => <ConnectionBadge isDark={isDark} />,
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: t("nav.accountTab"),
          tabBarIcon: ({ color, size }) => <Ionicons name="person-circle-outline" size={size} color={color as unknown as string} />,
          headerRight: () => <ConnectionBadge isDark={isDark} />,
        }}
      />
    </Tabs>
  )
}
