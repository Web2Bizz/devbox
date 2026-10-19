import { useCallback, useMemo } from "react"
import { View, TouchableOpacity } from "react-native"
import { Stack } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { s } from "@app/session/styles"

export interface SessionHeaderProps {
  title: string
  showInfo: boolean
  isDark: boolean
  onToggleInfo: () => void
}

// Заголовок сессии: expo-router прокидывает `options` по identity в
// layout-effect setOptions — инлайн-литерал вызывал бы setOptions на КАЖДЫЙ
// рендер (например, per streamed token), а обновление navigation-state
// ре-рендерило экран со свежими options снова ("Maximum update depth
// exceeded", Screen → setOptions). Новый объект — только при реальном
// изменении (title/фокус/тема).
export function SessionHeader({ title, showInfo, isDark, onToggleInfo }: SessionHeaderProps) {
  const headerRight = useCallback(() => {
    return (
      <View style={s.headerRight}>
        <TouchableOpacity onPress={onToggleInfo} hitSlop={8}>
          <Ionicons
            name={showInfo ? "stats-chart" : "stats-chart-outline"}
            size={20}
            color={showInfo ? "#FF2A7A" : isDark ? "#888888" : "#666666"}
          />
        </TouchableOpacity>
      </View>
    )
  }, [showInfo, isDark, onToggleInfo])
  const screenOptions = useMemo(() => ({ title, headerRight }), [title, headerRight])

  return <Stack.Screen options={screenOptions} />
}
