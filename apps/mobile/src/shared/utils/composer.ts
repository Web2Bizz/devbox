import { useState, useRef, useCallback } from "react"
import { Alert, Keyboard, TextInput } from "react-native"
import * as ImagePicker from "expo-image-picker"
import * as ImageManipulator from "expo-image-manipulator"
import * as Clipboard from "expo-clipboard"
import type { TFunction } from "i18next"
import type { Attachment } from "@web2bizz/ui-native"

// Hard input cap, mirrored in the TextInput's maxLength. Pastes that would
// overflow it are still applied (the native field truncates) but warn first.
export const MAX_COMPOSER_LENGTH = 10000

const MAX_DIMENSION = 1568 // Anthropic recommended max

async function toJpeg(uri: string, width: number, height: number): Promise<Attachment> {
  const actions: ImageManipulator.Action[] = []
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(width, height)
    actions.push({ resize: { width: Math.round(width * scale), height: Math.round(height * scale) } })
  }
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    format: ImageManipulator.SaveFormat.JPEG,
    compress: 0.8,
    base64: true,
  })
  return {
    uri: result.uri,
    mime: "image/jpeg",
    filename: "image.jpg",
    width: result.width,
    height: result.height,
    base64: result.base64 || undefined,
  }
}

export type ComposerState = {
  input: string
  setInput: (v: string | ((prev: string) => string)) => void
  attachments: Attachment[]
  setAttachments: (v: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void
  composerHeight: number | null
  setComposerHeight: (v: number | null) => void
  clearedRef: React.MutableRefObject<boolean>
  fieldRef: React.RefObject<TextInput | null>
  inputRef: React.MutableRefObject<string>
  clearComposer: () => void
  handleChangeText: (text: string) => void
  handleSuggestionPress: (promptKey: string) => void
  pickFromLibrary: () => Promise<void>
  pickFromCamera: () => Promise<void>
  pasteFromClipboard: () => Promise<void>
  removeAttachment: (index: number) => void
}

export function useComposer(t: TFunction): ComposerState {
  const [input, setInput] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [composerHeight, setComposerHeight] = useState<number | null>(null)
  const clearedRef = useRef(false)
  const fieldRef = useRef<TextInput | null>(null)
  const inputRef = useRef(input)
  inputRef.current = input

  const clearComposer = useCallback(() => {
    clearedRef.current = true
    setInput("")
    setComposerHeight(null)
    fieldRef.current?.setNativeProps({ selection: { start: 0, end: 0 } })
  }, [])

  const handleChangeText = useCallback((text: string) => {
    clearedRef.current = text.length === 0
    setInput(text)
  }, [])

  const pickFromLibrary = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 1,
    })
    if (result.canceled) return
    const settled = await Promise.allSettled(result.assets.map((a) => toJpeg(a.uri, a.width, a.height)))
    const items = settled.filter((r) => r.status === "fulfilled").map((r) => r.value)
    if (items.length) setAttachments((prev) => [...prev, ...items])
    if (settled.some((r) => r.status === "rejected")) {
      console.error(
        "Failed to process image(s):",
        settled.filter((r) => r.status === "rejected").map((r) => r.reason),
      )
      Alert.alert(t("session.alerts.imageFailedTitle"), t("session.alerts.imageFailedMessage"))
    }
  }, [t])

  const pickFromCamera = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      Alert.alert(t("session.alerts.cameraPermissionTitle"), t("session.alerts.cameraPermissionMessage"))
      return
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 1 })
    if (result.canceled) return
    const a = result.assets[0]
    try {
      const item = await toJpeg(a.uri, a.width, a.height)
      setAttachments((prev) => [...prev, item])
    } catch (err) {
      console.error("Failed to process photo:", err)
      Alert.alert(t("session.alerts.imageFailedTitle"), t("session.alerts.imageFailedMessage"))
    }
  }, [t])

  const pasteFromClipboard = useCallback(async () => {
    const hasImage = await Clipboard.hasImageAsync()
    if (hasImage) {
      const img = await Clipboard.getImageAsync({ format: "png" })
      if (img?.data) {
        const uri = img.data.startsWith("data:") ? img.data : `data:image/png;base64,${img.data}`
        const item = await toJpeg(uri, img.size.width, img.size.height)
        setAttachments((prev) => [...prev, item])
        return
      }
    }
    const hasText = await Clipboard.hasStringAsync()
    if (hasText) {
      const text = await Clipboard.getStringAsync()
      if (text) {
        if (inputRef.current.length + text.length > MAX_COMPOSER_LENGTH) {
          Alert.alert(t("session.alerts.pasteTruncatedTitle"), t("session.alerts.pasteTruncatedMessage"))
        }
        setInput((prev) => prev + text)
        return
      }
    }
    Alert.alert(t("session.alerts.emptyClipboardTitle"), t("session.alerts.emptyClipboardMessage"))
  }, [t])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleSuggestionPress = useCallback(
    (promptKey: string) => {
      handleChangeText(t(promptKey))
      fieldRef.current?.focus()
    },
    [handleChangeText, t],
  )

  return {
    input,
    setInput,
    attachments,
    setAttachments,
    composerHeight,
    setComposerHeight,
    clearedRef,
    fieldRef,
    inputRef,
    clearComposer,
    handleChangeText,
    handleSuggestionPress,
    pickFromLibrary,
    pickFromCamera,
    pasteFromClipboard,
    removeAttachment,
  }
}
