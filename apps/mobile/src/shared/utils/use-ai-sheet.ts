import { useCallback, useEffect, useRef } from "react"
import { Keyboard, Platform, type TextInput } from "react-native"
import type BottomSheet from "@gorhom/bottom-sheet"

// AI sheet must open AFTER the keyboard is gone: expanding while the
// composer holds focus leaves only the backdrop visible (the sheet never
// measures against the keyboard-resized layout). Blur + dismiss first,
// then expand once keyboardDidHide lands — with a fallback timer (~150ms
// Android / ~100ms iOS) and a next-tick fast path when the keyboard is
// already hidden. Pending flag guards double-tap; timer/listener are
// cleaned on unmount. Keeps the parent-owned sheetRef contract untouched.
export function useAiSheet(
  aiSheetRef: React.RefObject<BottomSheet | null>,
  fieldRef: React.RefObject<TextInput | null>,
  keyboardY: number | null,
): () => void {
  const aiSheetPendingRef = useRef(false)
  const aiSheetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aiSheetKbSubRef = useRef<{ remove: () => void } | null>(null)

  useEffect(
    () => () => {
      if (aiSheetTimerRef.current) clearTimeout(aiSheetTimerRef.current)
      aiSheetTimerRef.current = null
      aiSheetKbSubRef.current?.remove()
      aiSheetKbSubRef.current = null
      aiSheetPendingRef.current = false
    },
    [],
  )

  const openAiSheet = useCallback(() => {
    if (aiSheetPendingRef.current) return
    aiSheetPendingRef.current = true
    fieldRef.current?.blur()
    Keyboard.dismiss()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (aiSheetTimerRef.current) {
        clearTimeout(aiSheetTimerRef.current)
        aiSheetTimerRef.current = null
      }
      aiSheetKbSubRef.current?.remove()
      aiSheetKbSubRef.current = null
      aiSheetPendingRef.current = false
      aiSheetRef.current?.expand()
    }
    const keyboardVisible =
      typeof Keyboard.isVisible === "function" ? Keyboard.isVisible() : keyboardY !== null
    if (!keyboardVisible) {
      // Keyboard already hidden — expand on the next tick so blur/dismiss
      // commits before measuring.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(finish)
      } else {
        aiSheetTimerRef.current = setTimeout(finish, 0)
      }
      return
    }
    const sub = Keyboard.addListener("keyboardDidHide", finish)
    aiSheetKbSubRef.current = sub
    aiSheetTimerRef.current = setTimeout(finish, Platform.OS === "android" ? 150 : 100)
  }, [keyboardY])

  return openAiSheet
}
