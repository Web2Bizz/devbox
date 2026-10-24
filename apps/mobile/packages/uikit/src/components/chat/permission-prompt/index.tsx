import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { QUESTION_BODY_SCROLL_PROPS } from "../../../utils/session-layout"
import { colors } from "../../../theme"

type Props = {
  permission: { id: string; permission: string; patterns: string[] }
  isDark: boolean
  onReply: (reply: "once" | "always" | "reject") => void
}

export function PermissionPrompt({ permission, isDark, onReply }: Props) {
  const { t } = useTranslation()
  return (
    <View style={[s.card, isDark && s.cardDark]}>
      <View style={s.header}>
        <Ionicons name="shield-outline" size={18} color="#f59e0b" />
        <Text style={[s.title, isDark && s.textWhite]}>{t("chat.permissionPrompt.title")}</Text>
      </View>
      {/* Длинный список паттернов скроллится внутри карточки — карточка при
          этом ужата лимитом оверлея (70% высоты экрана), а не растёт вниз. */}
      <ScrollView
        {...QUESTION_BODY_SCROLL_PROPS}
        style={s.body}
        contentContainerStyle={s.patterns}
        testID="permission-patterns-scroll"
      >
        <Text style={[s.type, isDark && s.typeDark]}>
          {permission.permission}: {permission.patterns.join(", ")}
        </Text>
      </ScrollView>
      <View style={s.actions}>
        <TouchableOpacity style={[s.btn, s.deny]} onPress={() => onReply("reject")}>
          <Text style={s.denyText}>{t("chat.permissionPrompt.deny")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.always, isDark && s.alwaysDark]} onPress={() => onReply("always")}>
          <Text style={[s.alwaysText, isDark && s.textWhite]}>{t("chat.permissionPrompt.always")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.allow, isDark && s.allowDark]} onPress={() => onReply("once")}>
          <Text style={[s.allowText, isDark && s.allowTextDark]}>{t("chat.permissionPrompt.allow")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    flexShrink: 1,
    // Без внешних отступов: инсеты (включая нижний — как у поля ввода) задаёт
    // оверлей промптов в session/prompt-overlay, иначе низ двоится (padding + margin).
    margin: 0,
    padding: 16,
    backgroundColor: "#fffbeb",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#fef3c7",
  },
  cardDark: { backgroundColor: "#1a1800", borderColor: "#333300" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  title: { fontSize: 15, fontWeight: "600", color: "#92400e" },
  textWhite: { color: "#ffffff" },
  body: { flexShrink: 1 },
  patterns: { paddingBottom: 1 },
  type: { fontSize: 13, color: "#78350f", marginBottom: 12 },
  typeDark: { color: colors.warningSoftText },
  actions: { flexDirection: "row", gap: 8 },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  deny: { backgroundColor: "#fef2f2" },
  denyText: { color: "#dc2626", fontWeight: "600", fontSize: 14 },
  always: { backgroundColor: "#f5f5f5" },
  alwaysDark: { backgroundColor: "#2a2a2a" },
  alwaysText: { color: "#0a0a0a", fontWeight: "600", fontSize: 14 },
  allow: { backgroundColor: "#0a0a0a" },
  allowDark: { backgroundColor: "#ffffff" },
  allowText: { color: "#ffffff", fontWeight: "600", fontSize: 14 },
  allowTextDark: { color: "#0a0a0a" },
})
