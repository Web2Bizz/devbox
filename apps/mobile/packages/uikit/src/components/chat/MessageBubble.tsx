import { memo } from "react"
import { View, Text, Image, StyleSheet, ScrollView, TouchableOpacity, Dimensions, Linking } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { Markdown } from "../markdown"
import { ToolCallCard } from "./ToolCallCard"
import { ReasoningBlock } from "./ReasoningBlock"
import { extractGitHubUrls } from "../../utils/github-links"
import type { Message, Part } from "../../types"

const SCREEN_WIDTH = Dimensions.get("window").width

function isImageMime(mime?: string): boolean {
  return !!mime && mime.startsWith("image/")
}

interface Props {
  message: Message
  parts: Part[]
  isDark: boolean
  // Only wired up for user messages — long-press opens the "Edit message" /
  // revert action sheet. Identified by messageID (not a closure over parts)
  // so it stays correct even if the memo below bails on a stale render.
  onLongPress?: (messageID: string) => void
}

// TODO: Replace with streamdown-rn once React 19 types PR lands - it has
// built-in block-level memoization that eliminates re-renders for stable blocks
export const MessageBubble = memo(
  function MessageBubble({ message, parts, isDark, onLongPress }: Props) {
    const isUser = message.role === "user"
    const { t } = useTranslation()

    const textParts = parts.filter((p) => p.type === "text")
    const reasoningParts = parts.filter((p) => p.type === "reasoning")
    const toolParts = parts.filter((p) => p.type === "tool")
    const fileParts = parts.filter((p) => p.type === "file" && isImageMime(p.mime))
    const text = textParts.map((p) => p.text).join("\n") || ""
    const reasoning = reasoningParts.map((p) => p.text).join("\n") || ""
    // GitHub links shared by the agent — one "open" button per unique URL
    // under the message. User bubbles stay untouched (plain text, no links).
    const githubUrls = isUser ? [] : extractGitHubUrls(text)
    // True when tools follow text/reasoning/images inside the SAME bubble:
    // then the toolList needs its own 16px top gap. When a bubble starts
    // with tools, marginTop stays 0 and the 16px comes from the surrounding
    // 8 (prev padBottom) + 0 (margin) + 8 (this padTop) paddings.
    const toolsAfterContent = text.length > 0 || reasoning.length > 0 || fileParts.length > 0

    return (
      <TouchableOpacity
        activeOpacity={isUser && onLongPress ? 0.7 : 1}
        onLongPress={isUser && onLongPress ? () => onLongPress(message.id) : undefined}
        disabled={!isUser || !onLongPress}
        style={[
          s.bubble,
          isUser ? s.user : s.assistant,
          isUser && isDark && s.userDark,
          !isUser && isDark && s.assistantDark,
        ]}
        testID={`chat-bubble-${message.role}`}
      >
        {/* Image attachments */}
        {fileParts.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.imageRow}
            style={s.imageScroll}
          >
            {fileParts.map((fp) => (
              <View key={fp.id} style={s.imageWrap}>
                <Image source={{ uri: fp.url }} style={s.attachedImage} resizeMode="cover" />
                {fp.filename && (
                  <Text style={[s.imageLabel, isDark && s.imageLabelDark]} numberOfLines={1}>
                    {fp.filename}
                  </Text>
                )}
              </View>
            ))}
          </ScrollView>
        )}

        {/* Reasoning (collapsible) */}
        {reasoning.length > 0 && <ReasoningBlock text={reasoning} isDark={isDark} />}

        {/* Message text */}
        {text.length > 0 &&
          (isUser ? (
            <Text style={[s.messageText, isDark && s.textWhite]} selectable>
              {text}
            </Text>
          ) : (
            <View style={s.markdownWrap}>
              <Markdown>{text}</Markdown>
            </View>
          ))}

        {/* GitHub links from the agent — direct "open" buttons under the text.
            (Inline markdown links are tap-to-copy by design, see CopyLink.) */}
        {githubUrls.length > 0 && (
          <View style={s.githubList}>
            {githubUrls.map((url) => (
              <TouchableOpacity
                key={url}
                style={[s.githubBtn, isDark && s.githubBtnDark]}
                onPress={() => void Linking.openURL(url).catch(() => {})}
                testID="github-open-button"
                accessibilityRole="button"
                accessibilityLabel={t("chat.githubLink.openButton")}
              >
                <Ionicons name="logo-github" size={16} color={isDark ? "#e5e5e5" : "#0a0a0a"} />
                <Text style={[s.githubBtnText, isDark && s.githubBtnTextDark]}>
                  {t("chat.githubLink.openButton")}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Tool calls — uniform rhythm via the container gap, not per-card
            margins, so every row in a series sits equally apart.
            Rhythm math (all assistant adjacencies = 16):
            intra-bubble text→tools 16 (toolListAfterContent marginTop),
            tools→tools 16 (toolList gap), cross-bubble anything→anything 16
            (8 padBottom + 0 margin + 8 padTop), assistant→user stays 20
            (8 pad + 12 user padding). User bubble untouched. */}
        {toolParts.length > 0 && (
          <View style={[s.toolList, toolsAfterContent && s.toolListAfterContent]}>
            {toolParts.map((tool) => (
              <ToolCallCard key={tool.id} tool={tool} isDark={isDark} />
            ))}
          </View>
        )}

        {/* Model + tokens/cost for assistant messages — hidden after tool call per request */}
        {!isUser &&
          toolParts.length === 0 &&
          (() => {
            const modelName = message.model?.modelID || message.modelID || ""
            const hasTokens = !!message.tokens
            const hasModel = !!modelName
            if (!hasTokens && !hasModel) return null
            const parts: string[] = []
            if (hasModel) parts.push(modelName.split("/").pop() || modelName)
            if (hasTokens) parts.push(`${message.tokens!.input + message.tokens!.output} tokens`)
            if (message.cost) parts.push(`$${message.cost.toFixed(4)}`)
            return <Text style={[s.tokens, isDark && s.tokensDark]}>{parts.join(" · ")}</Text>
          })()}
      </TouchableOpacity>
    )
  },
  (prev, next) => {
    // Only re-render if message content actually changed
    // This prevents completed messages from re-rendering during streaming.
    // The store replaces changed parts/messages with NEW object references,
    // so a reference-equality sweep over every part catches every real change
    // (including tool parts, which have no `.text`) while still skipping
    // unchanged (completed) messages during other messages' streaming.
    if (prev.message !== next.message) return false
    if (prev.isDark !== next.isDark) return false
    if (prev.onLongPress !== next.onLongPress) return false
    if (prev.parts.length !== next.parts.length) return false
    for (let i = 0; i < prev.parts.length; i++) {
      if (prev.parts[i] !== next.parts[i]) return false
    }
    return true
  },
)

const s = StyleSheet.create({
  bubble: { marginBottom: 16, padding: 12, borderRadius: 12, maxWidth: "100%" },
  user: {
    backgroundColor: "#f5f5f5",
    marginLeft: 32,
    // Ширина по контенту: пузырь прижат вправо и ужатывается под текст,
    // потолок — maxWidth 100% из базового стиля (как раньше на всю ширину).
    alignSelf: "flex-end",
  },
  userDark: { backgroundColor: "#1a1a1a" },
  assistant: {
    backgroundColor: "transparent",
    alignSelf: "stretch",
    width: "100%",
    marginLeft: 0,
    marginRight: 0,
    // Consecutive assistant bubbles must flow as one series: keep 0 here so
    // the cross-bubble gap is exactly padBottom 8 + padTop 8 = 16.
    marginBottom: 0,
    paddingHorizontal: 0,
    paddingVertical: 8,
  },
  assistantDark: { backgroundColor: "transparent" },

  textWhite: { color: "#ffffff" },

  messageText: { fontSize: 15, lineHeight: 22, color: "#0a0a0a" },
  markdownWrap: { marginHorizontal: -4 },
  // Tool-call series: one 16px gap value for text→card and card→card alike.
  // Base has marginTop 0; toolListAfterContent adds 16 only when tools follow
  // content in the same bubble (see rhythm math above).
  toolList: { marginTop: 0, marginBottom: 0, gap: 16 },
  toolListAfterContent: { marginTop: 16 },

  tokens: { fontSize: 11, color: "#999999", marginTop: 8 },
  tokensDark: { color: "#666666" },

  // "Open in GitHub" buttons under agent messages with github.com links.
  githubList: { marginTop: 8, gap: 8 },
  githubBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#f5f5f5",
  },
  githubBtnDark: { borderColor: "#2a2a2a", backgroundColor: "#1a1a1a" },
  githubBtnText: { fontSize: 14, fontWeight: "600", color: "#0a0a0a" },
  githubBtnTextDark: { color: "#e5e5e5" },

  // Images
  imageScroll: { marginBottom: 8 },
  imageRow: { gap: 8 },
  imageWrap: { alignItems: "center" },
  attachedImage: {
    width: Math.min(200, SCREEN_WIDTH * 0.5),
    height: Math.min(200, SCREEN_WIDTH * 0.5),
    borderRadius: 8,
    backgroundColor: "#e5e5e5",
  },
  imageLabel: { fontSize: 10, color: "#666666", marginTop: 2, maxWidth: 200 },
  imageLabelDark: { color: "#888888" },
})
