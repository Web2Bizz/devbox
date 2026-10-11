import { useMemo } from "react"
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Keyboard, Platform } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { colors } from "../../theme"

export interface SlashCommand {
  trigger: string
  title: string
  description?: string
  icon: string
  type: "builtin" | "custom"
}

interface Props {
  query: string
  commands: SlashCommand[]
  isDark: boolean
  onSelect: (cmd: SlashCommand) => void
}

export function SlashPopover({ query, commands, isDark, onSelect }: Props) {
  const { t } = useTranslation()
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return commands.filter((c) => c.trigger.toLowerCase().startsWith(q) || c.title.toLowerCase().includes(q))
  }, [query, commands])

  if (filtered.length === 0) return null

  return (
    <View style={[s.popover, isDark && s.popoverDark]}>
      <ScrollView
        keyboardShouldPersistTaps="always"
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        bounces={false}
      >
        {filtered.map((cmd, i) => (
          <TouchableOpacity
            key={cmd.trigger}
            style={[s.item, isDark && s.itemDark, i < filtered.length - 1 && (isDark ? s.separatorDark : s.separator)]}
            onPress={() => onSelect(cmd)}
          >            <Ionicons
              name={cmd.icon as any}
              size={18}
              color={cmd.type === "custom" ? colors.accent : isDark ? "#888888" : "#666666"}
            />
            <View style={s.textCol}>
              <Text style={[s.trigger, isDark && s.textWhite]}>/{cmd.trigger}</Text>
              {cmd.description && (
                <Text style={[s.desc, isDark && s.metaDark]} numberOfLines={1}>
                  {cmd.description}
                </Text>
              )}
            </View>
            {cmd.type === "custom" && (
              <View style={[s.badge, isDark && s.badgeDark]}>
                <Text style={s.badgeText}>{t("chat.slashPopover.customBadge")}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  // Карточка в языке приложения: БЕЗ скруглений — палитра выходит из-под
  // блока ввода, низ прячется за полем, углы должны быть прямыми.
  // Фон — как у поля ввода (#f5f5f5 / #1a1a1a), тень для отрыва от списка.
  popover: {
    backgroundColor: "#f5f5f5",
    borderWidth: 1,
    borderColor: "#e5e5e5",
    borderRadius: 0,
    maxHeight: 220,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  popoverDark: { backgroundColor: "#1a1a1a", borderColor: "#2a2a2a" },
  // ScrollView должен сам быть ограничен по высоте (flexGrow: 0 + maxHeight):
  // иначе он меряет полный контент, внешняя maxHeight: 220 лишь обрезает
  // (overflow: hidden), а скролл не появляется. Паддинги — в contentContainer,
  // чтобы не ломать измерение скроллируемой области.
  scroll: { maxHeight: 212, flexGrow: 0 },
  scrollContent: { paddingVertical: 4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  itemDark: {},
  separator: { borderBottomWidth: 1, borderBottomColor: "#e5e5e5" },
  separatorDark: { borderBottomWidth: 1, borderBottomColor: "#2a2a2a" },
  textCol: { flex: 1 },
  trigger: { fontSize: 14, fontWeight: "600", color: "#0a0a0a" },
  textWhite: { color: "#ffffff" },
  desc: { fontSize: 12, color: "#999999", marginTop: 1 },
  metaDark: { color: "#666666" },
  badge: {
    backgroundColor: colors.accentMuted,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeDark: { backgroundColor: colors.accentMutedDark },
  badgeText: { fontSize: 10, color: colors.accent, fontWeight: "600" },
})
