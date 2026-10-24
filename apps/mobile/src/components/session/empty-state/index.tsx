import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { colors } from "@web2bizz/ui-native"
import { s } from "@app/session/styles"

export const SUGGESTIONS = [
  { key: "fixBug", icon: "bug-outline", labelKey: "session.empty.suggestions.fixBug", promptKey: "session.empty.prompts.fixBug" },
  { key: "newTask", icon: "list-outline", labelKey: "session.empty.suggestions.newTask", promptKey: "session.empty.prompts.newTask" },
  { key: "writeTest", icon: "flask-outline", labelKey: "session.empty.suggestions.writeTest", promptKey: "session.empty.prompts.writeTest" },
  { key: "reviewCode", icon: "eye-outline", labelKey: "session.empty.suggestions.reviewCode", promptKey: "session.empty.prompts.reviewCode" },
  { key: "checkCicd", icon: "git-branch-outline", labelKey: "session.empty.suggestions.checkCicd", promptKey: "session.empty.prompts.checkCicd" },
] as const

export function EmptyState({ isDark, onSuggestion }: { isDark: boolean; onSuggestion: (promptKey: string) => void }) {
  const { t } = useTranslation()
  return (
    <View style={s.emptyOverlay} pointerEvents="box-none">
      <Ionicons name="chatbubble-outline" size={48} color={isDark ? "#444444" : "#cccccc"} />
      <Text style={[s.emptyText, isDark && s.metaDark]}>{t("session.empty.suggestionsTitle")}</Text>
      <View style={s.suggestionsWrap}>
        {SUGGESTIONS.map((item) => (
          <TouchableOpacity
            key={item.key}
            style={[s.suggestionChip, isDark && s.suggestionChipDark]}
            onPress={() => onSuggestion(item.promptKey)}
            testID={`suggestion-${item.key}`}
            accessibilityRole="button"
            accessibilityLabel={t(item.labelKey)}
          >
            <Ionicons
              name={item.icon as keyof typeof Ionicons.glyphMap}
              size={16}
              color={isDark ? colors.textPlaceholder : colors.neutral.gray600}
            />
            <Text style={[s.suggestionText, isDark && s.suggestionTextDark]}>{t(item.labelKey)}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={[s.emptyHint, isDark && s.metaDark]}>{t("session.empty.hint")}</Text>
    </View>
  )
}