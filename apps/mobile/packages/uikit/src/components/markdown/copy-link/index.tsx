import { useEffect, useRef, useState, type ReactNode } from "react"
import { Text, Linking, type StyleProp, type TextStyle } from "react-native"
import * as Clipboard from "expo-clipboard"

// Markdown link with Telegram-style behavior: a tap copies the URL,
// a long press opens it. Brief "✓" confirms the copy inline.
// Pure atom — no theme / store deps, no hex literals to tokenize.
export function CopyLink({
  href,
  style,
  children,
}: {
  href: string
  style?: StyleProp<TextStyle>
  children: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const onPress = async () => {
    try {
      await Clipboard.setStringAsync(href)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable — leave the link as-is.
    }
  }

  const onLongPress = () => {
    void Linking.openURL(href).catch(() => {})
  }

  return (
    <Text accessibilityRole="link" onPress={onPress} onLongPress={onLongPress} style={style} testID="md-link">
      {children}
      {copied ? " ✓" : null}
    </Text>
  )
}
