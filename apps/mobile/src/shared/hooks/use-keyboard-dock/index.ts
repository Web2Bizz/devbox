import { useEffect, useState } from "react"
import { Keyboard, Platform, useWindowDimensions } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { composerMaxHeight, COMPOSER_MIN_HEIGHT } from "@web2bizz/ui-native"

export type KeyboardDock = {
  keyboardY: number | null
  keyboardH: number
  dockHeight: number
  setDockHeight: (height: number) => void
  inputMaxHeight: number
  composerFieldHeight: number
}

// Клавиатура + геометрия дока: keyboardH вручную поднимает absolute-док
// (KeyboardAvoidingView своим padding двигает только in-flow контент,
// абсолютно спозиционированный док его игнорирует), dockHeight уходит в
// нижний отступ списка сообщений, чтобы не проваливались под overlay.
export function useKeyboardDock(composerHeight: number | null): KeyboardDock {
  const [keyboardY, setKeyboardY] = useState<number | null>(null)
  // Высота клавиатуры — нижний док (overlay) поднимается над ней вручную:
  // KeyboardAvoidingView своим padding двигает только in-flow контент,
  // абсолютно спозиционированный док его игнорирует.
  const [keyboardH, setKeyboardH] = useState(0)
  // Замеренная высота нижнего дока (квик-действия + ввод + аттачменты;
  // промпты — absolute-оверлей и в замер не входят):
  // уходит в нижний отступ списка сообщений, чтобы не проваливались под overlay.
  const [dockHeight, setDockHeight] = useState(0)

  const insets = useSafeAreaInsets()
  const { height: windowHeight, fontScale } = useWindowDimensions()

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", (event) => {
      setKeyboardY(event.endCoordinates.screenY)
      setKeyboardH(event.endCoordinates.height ?? 0)
    })
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => {
      setKeyboardY(null)
      setKeyboardH(0)
    })
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  const inputMaxHeight = composerMaxHeight(Platform.OS, windowHeight, keyboardY, insets.top, fontScale)
  // Controlled field height: grow with content, snap back to the floor on reset.
  // The floor is COMPOSER_MIN_HEIGHT (88 = one text line + the input's vertical
  // padding), NOT 80: a lower floor clips the first line inside the fixed box
  // (paddingTop 12 + line ~24 + paddingBottom 52 for the overlay buttons), and
  // the field only looked right again once a newline grew the measurement past
  // the deficit. Must mirror s.input.minHeight.
  const composerFieldHeight = Math.max(
    COMPOSER_MIN_HEIGHT,
    Math.min(composerHeight ?? COMPOSER_MIN_HEIGHT, inputMaxHeight),
  )

  return { keyboardY, keyboardH, dockHeight, setDockHeight, inputMaxHeight, composerFieldHeight }
}
