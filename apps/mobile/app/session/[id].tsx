import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  useColorScheme,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Keyboard,
  useWindowDimensions,
} from "react-native"
import { useLocalSearchParams, Stack, useRouter, useFocusEffect } from "expo-router"
import type BottomSheet from "@gorhom/bottom-sheet"
import { Ionicons } from "@expo/vector-icons"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { LinearGradient } from "expo-linear-gradient"
import { useTranslation } from "react-i18next"
import * as ImagePicker from "expo-image-picker"
import * as ImageManipulator from "expo-image-manipulator"
import * as Clipboard from "expo-clipboard"
import {
  MessageBubble,
  PermissionPrompt,
  QuestionPrompt,
  StatusIndicator,
  SlashPopover,
  AiSettingsModal,
  ImageAttachments,
  MessageQueueSheet,
  SessionInfo,
  type SlashCommand,
  type Attachment,
} from "@web2bizz/ui-native"
import { useSessions } from "../../src/stores/sessions"
import type { QueuedDraft } from "../../src/stores/sessions"
import { useEvents, refreshPending } from "../../src/stores/events"
import { useCatalogData } from "../../src/queries/catalog"
import {
  useAbortSession,
  useRevertSession,
  useUnrevertSession,
  usePermissionReply,
  useQuestionReply,
  useQuestionReject,
  type RevertResult,
} from "../../src/queries/session-ops"
import { useConnections } from "../../src/stores/connections"
import { useAuth } from "../../src/stores/auth"
import { useCatalog } from "../../src/stores/catalog"
import { useSpeech } from "../../src/lib/speech"
import { composerMaxHeight, keyboardVerticalOffset, COMPOSER_MIN_HEIGHT } from "@web2bizz/ui-native"

// --- Builtin slash commands ---
// Hard input cap, mirrored in the TextInput's maxLength below. Pastes that
// would overflow it are still applied (the native field truncates) but warn
// first — otherwise long logs silently lose their tail.
const MAX_COMPOSER_LENGTH = 10000
const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    trigger: "new",
    title: "New Session",
    description: "Start a new session",
    icon: "add-circle-outline",
    type: "builtin",
  },
  {
    trigger: "model",
    title: "Switch Model",
    description: "Choose a different model",
    icon: "hardware-chip-outline",
    type: "builtin",
  },
  {
    trigger: "agent",
    title: "Switch Agent",
    description: "Cycle to next agent",
    icon: "person-outline",
    type: "builtin",
  },
]

// Quick actions offered on an empty (new) chat. Tapping one prefills the
// composer — it never sends by itself.
const SUGGESTIONS = [
  { key: "fixBug", icon: "bug-outline", labelKey: "session.empty.suggestions.fixBug", promptKey: "session.empty.prompts.fixBug" },
  { key: "newTask", icon: "list-outline", labelKey: "session.empty.suggestions.newTask", promptKey: "session.empty.prompts.newTask" },
  { key: "writeTest", icon: "flask-outline", labelKey: "session.empty.suggestions.writeTest", promptKey: "session.empty.prompts.writeTest" },
  { key: "reviewCode", icon: "eye-outline", labelKey: "session.empty.suggestions.reviewCode", promptKey: "session.empty.prompts.reviewCode" },
  { key: "checkCicd", icon: "git-branch-outline", labelKey: "session.empty.suggestions.checkCicd", promptKey: "session.empty.prompts.checkCicd" },
] as const

// Shared stable empty queue: the per-session selector below must not mint a
// fresh `[]` on every store notification (new reference = re-render and new
// downstream props on every unrelated update, e.g. per streamed token).
const EMPTY_QUEUE: QueuedDraft[] = []

export default function SessionScreen() {
  const { id, directory, connectionId } = useLocalSearchParams<{
    id: string
    directory?: string
    connectionId?: string
  }>()
  const router = useRouter()
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const insets = useSafeAreaInsets()
  const { height: windowHeight, fontScale } = useWindowDimensions()
  const { t } = useTranslation()

  const flatListRef = useRef<FlatList>(null)
  const aiSheetRef = useRef<BottomSheet | null>(null)
  const queueSheetRef = useRef<BottomSheet | null>(null)
  const [input, setInput] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Explicit composer height: the native multiline measurement doesn't reliably
  // shrink back after a programmatic clear on Android, so track content height
  // and drive the field height ourselves (clamped to [minHeight, maxHeight]).
  // null = natural height (floor applies).
  const [composerHeight, setComposerHeight] = useState<number | null>(null)
  // Native handle for scroll resets (see clearComposer below).
  const fieldRef = useRef<TextInput | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [keyboardY, setKeyboardY] = useState<number | null>(null)
  // Высота клавиатуры — нижний док (overlay) поднимается над ней вручную:
  // KeyboardAvoidingView своим padding двигает только in-flow контент,
  // абсолютно спозиционированный док его игнорирует.
  const [keyboardH, setKeyboardH] = useState(0)
  // Замеренная высота нижнего дока (квик-действия + ввод + аттачменты;
  // промпты — absolute-оверлей и в замер не входят):
  // уходит в нижний отступ списка сообщений, чтобы не проваливались под overlay.
  const [dockHeight, setDockHeight] = useState(0)

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

  const {
    currentSession,
    messages,
    parts,
    isLoading,
    loadingMore,
    hasMore,
    selectSession,
    sendMessage,
    loadOlderMessages,
  } = useSessions()
  // Discrete server ops as React Query mutations (optimistic UI + rollback
  // inside, alerts stay at the call sites).
  const abortMutation = useAbortSession()
  const revertMutation = useRevertSession()
  const unrevertMutation = useUnrevertSession()
  const permissionMutation = usePermissionReply()
  const questionMutation = useQuestionReply()
  const questionRejectMutation = useQuestionReject()

  // Busy = optimistic sending flag OR SSE-reported status. The optimistic
  // flag alone is not enough: it only bridges the gap between tap and SSE
  // busy, and a re-entry (useFocusEffect → selectSession) used to clear it —
  // so after leaving and returning to a running chat the Stop button
  // disappeared even though the server was still busy. SSE status persists
  // globally across navigation, so it keeps the button visible.
  const optimisticSending = useSessions((s) => !!(currentSession && s.sending[currentSession.id]))
  const queuedForSession = useSessions((s) => (currentSession ? (s.queue[currentSession.id] ?? EMPTY_QUEUE) : EMPTY_QUEUE))
  const enqueueMessage = useSessions((s) => s.enqueueMessage)
  const sseBusy = useEvents(
    (s) => !!currentSession && !!s.sessionStatus[currentSession.id] && s.sessionStatus[currentSession.id].type !== "idle",
  )
  const isSending = optimisticSending || sseBusy

  const { authenticateForMessage } = useAuth()
  const { client, clientForDirectory } = useConnections()

  // Origin-aware client: the open session's own server (cloud or LAN), never
  // just the active connection.
  const sessionClient = useMemo(
    () =>
      currentSession?.directory
        ? (clientForDirectory(currentSession.directory, currentSession.connectionId) ?? client)
        : currentSession
          ? (clientForDirectory(undefined, currentSession.connectionId) ?? client)
          : client,
    [currentSession?.directory, currentSession?.connectionId, clientForDirectory, client],
  )

  // Catalog lists from the React Query cache, scoped to the open session's
  // server; the agent/model/variant SELECTIONS stay local (Zustand) and are
  // seeded from each fresh snapshot.
  const { data: catalogData } = useCatalogData(currentSession?.connectionId)
  useEffect(() => {
    // Skip empty snapshots (e.g. a server that answered 401): reseeding from
    // nothing would wipe a still-valid selection.
    if (catalogData && (catalogData.agents.length > 0 || catalogData.providers.length > 0)) {
      useCatalog.getState().reseed(catalogData)
    }
  }, [catalogData])
  const agents = catalogData?.agents ?? []
  const serverCommands = catalogData?.commands ?? []
  const providers = catalogData?.providers ?? []
  const agent = useCatalog((s) => s.agent) || ""
  const model = useCatalog((s) => s.model)
  const setModel = useCatalog((s) => s.setModel)
  const variant = useCatalog((s) => s.variant)
  const setVariant = useCatalog((s) => s.setVariant)
  const setAgentInStore = useCatalog((s) => s.setAgent)
  const setAgent = useCallback((name: string) => setAgentInStore(name, agents), [setAgentInStore, agents])

  // Permission & question state
  const sessionID = currentSession?.id
  const permissions = useEvents((s) => (sessionID ? s.permissions[sessionID] : undefined)) || []
  const questions = useEvents((s) => (sessionID ? s.questions[sessionID] : undefined)) || []

  const [showScrollButton, setShowScrollButton] = useState(false)

  // SSE reconnect banner
  const reconnectAttempts = useEvents((s) => s.reconnectAttempts)
  const [showConnectedFlash, setShowConnectedFlash] = useState(false)
  const prevReconnecting = useRef(false)

  // Voice input — transcript appends to the text input on completion
  const speech = useSpeech(
    useCallback((text: string) => {
      setInput((prev) => (prev ? prev + " " + text : text))
    }, []),
  )

  // Surface speech recognition failures with the native error detail
  // (e.g. "not-allowed", "service-not-allowed") so the alert is diagnosable.
  // Keyed on the error value itself so it only fires once per distinct error,
  // not on every re-render while it remains set.
  useEffect(() => {
    if (!speech.error) return
    Alert.alert(t("session.alerts.speechErrorTitle"), `${t("session.alerts.speechErrorMessage")}\n\n${speech.error}`)
  }, [speech.error, t])

  // One-time surface for store-level action failures that have no call-site
  // alert (abort, unrevert). Send/revert failures alert at their call sites
  // and never write the store flag, so this can't double-alert.
  const sessionError = useSessions((s) => s.error)
  const clearSessionError = useSessions((s) => s.clearError)
  useEffect(() => {
    if (!sessionError) return
    Alert.alert(t("common.error"), sessionError)
    clearSessionError()
  }, [sessionError, clearSessionError, t])

  // Slash command state. slashHidden закрывает палитру тапом мимо неё
  // (текст сохраняется); любой ввод открывает заново.
  const [slashHidden, setSlashHidden] = useState(false)
  const slashActive = input.startsWith("/") && !input.includes(" ") && !slashHidden
  const slashQuery = slashActive ? input.slice(1) : ""

  const allCommands = useMemo<SlashCommand[]>(() => {
    const custom: SlashCommand[] = serverCommands.map((cmd) => ({
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      icon: "code-slash-outline",
      type: "custom",
    }))
    return [...custom, ...BUILTIN_COMMANDS]
  }, [serverCommands])

  // While a revert is pending, the reverted message and everything after it
  // still exist server-side (cleanup only runs on the next prompt/unrevert)
  // — hide them client-side so editing feels immediate. Message IDs are
  // lexicographically sortable, same comparison the TUI uses. Optimistic
  // "temp-" IDs (assigned client-side before the server responds, see
  // sendMessage) aren't part of that sort order — always keep them so a
  // message sent concurrently with a revert isn't hidden.
  const revertMessageID = currentSession?.revert?.messageID

  // Inverted FlatList: data is reversed (newest first) so newest renders at bottom
  const messageData = useMemo(
    () =>
      (messages || [])
        .filter((msg) => !revertMessageID || msg.id.startsWith("temp-") || msg.id < revertMessageID)
        .map((msg) => ({
          message: msg,
          parts: (parts && parts[msg.id]) || [],
        }))
        .reverse(),
    [messages, parts, revertMessageID],
  )

  // Tracks the latest composer text without pulling `input` into
  // handleMessageLongPress's deps — kept as a plain ref assignment (not
  // state) so the callback below stays referentially stable across
  // keystrokes for MessageBubble's custom memo comparator.
  const inputRef = useRef(input)
  inputRef.current = input

  const applyRevertResult = useCallback(
    (result: RevertResult) => {
      if (!result.ok) {
        if (result.reason === "unsupported") {
          Alert.alert(t("session.alerts.notSupportedTitle"), t("session.alerts.notSupportedMessage"))
        } else if (result.reason === "auth") {
          Alert.alert(t("session.alerts.revertAuthFailedTitle"), t("session.alerts.revertAuthFailedMessage"))
        } else {
          Alert.alert(t("session.alerts.editFailedTitle"), t("session.alerts.editFailedMessage"))
        }
        return
      }
      setInput(result.text)
      // Restore attachments in the same shape the composer's own picker
      // functions (pickFromLibrary/pickFromCamera/pasteFromClipboard) use.
      setAttachments(
        result.files
          .filter((f): f is typeof f & { url: string; mime: string } => !!f.url && !!f.mime)
          .map((f) => ({ uri: f.url, mime: f.mime, filename: f.filename })),
      )
    },
    [t],
  )

  // Stable across renders (reads fresh state via getState() rather than
  // closing over props) so MessageBubble's custom memo comparator can bail
  // safely without risking a stale handler.
  const handleMessageLongPress = useCallback((messageID: string) => {
    Alert.alert(t("session.alerts.messageActionsTitle"), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("session.actions.editMessage"),
        onPress: () => {
          const doRevert = async () => {
            const result = await revertMutation.mutateAsync(messageID)
            applyRevertResult(result)
          }
          // Editing overwrites the composer — don't silently clobber an
          // in-progress unsent draft.
          if (inputRef.current.trim()) {
            Alert.alert(
              t("session.alerts.replaceDraftTitle"),
              t("session.alerts.replaceDraftMessage"),
              [
                { text: t("common.cancel"), style: "cancel" },
                { text: t("session.actions.replace"), style: "destructive", onPress: doRevert },
              ],
              { cancelable: false },
            )
            return
          }
          doRevert()
        },
      },
    ])
  }, [applyRevertResult, revertMutation, t])

  const scrollToBottom = useCallback((animated = true) => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated })
  }, [])

  // Auto-scroll when status appears at bottom of messages (fixed in list)
  const statusForScroll = useEvents((s) => (currentSession ? s.sessionStatus[currentSession.id] : undefined))
  const statusTextForScroll = useEvents((s) => (currentSession ? s.statusText[currentSession.id] : undefined))
  useEffect(() => {
    if (statusForScroll && statusForScroll.type !== "idle") {
      scrollToBottom(true)
    }
  }, [statusForScroll, statusTextForScroll])

  // Re-select on every focus, not just mount. currentSession/messages/
  // permissions are a single global store, and the native stack keeps screens
  // underneath a pushed one mounted. Without re-selecting on focus, navigating
  // to another session and back would leave this screen bound to the *other*
  // session's data (and its permission/question prompts) — so a user could
  // approve the wrong session's tool call. useFocusEffect re-binds this screen
  // to its own session whenever it becomes visible again.
  useFocusEffect(
    useCallback(() => {
      if (!id) return
      selectSession(id, directory, connectionId).then(() => {
        // Re-fetch pending permissions/questions from the server to recover from
        // missed SSE events or failed optimistic removals
        const connState = useConnections.getState()
        const c = directory
          ? (connState.clientForDirectory(directory, connectionId) ?? connState.client)
          : connectionId
            ? (connState.clientForConnection(connectionId) ?? connState.client)
            : connState.client
        if (c) refreshPending(c, id)
      })
    }, [id, directory, connectionId]),
  )

  // Sync model chip from latest assistant message
  useEffect(() => {
    if (!messages || messages.length === 0) return
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === "assistant" && msg.providerID && msg.modelID) {
        setModel({ providerID: msg.providerID, modelID: msg.modelID })
        return
      }
      if (msg.role === "user" && msg.model) {
        setModel(msg.model)
        return
      }
    }
  }, [currentSession?.id, messages?.length])

  // Clear the composer back to its resting geometry: empty text, floor
  // height, native scroll at the top. All three must move together:
  // - setInput("") alone is not enough: on Android a contentSize event for
  //   the pre-clear text can land AFTER the reset (see the gate in
  //   onContentSizeChange) and resurrect a tall box, and the native scroll
  //   offset survives the clear — the next typed line then paints shifted
  //   over the top padding;
  // - setComposerHeight(null) alone snaps the box but not the scroll.
  // Selection 0 forces the native scroll to the top synchronously, before
  // the async clear lands — either order ends at offset 0.
  // clearedRef marks the stale-measurement window opened here: while it is
  // set AND the committed text is still empty, contentSize events are
  // pre-clear echoes and must be ignored. Any real text — user-typed (which
  // clears the flag via handleChangeText even before its render commits) or
  // programmatic (prefill/paste/restore, which never fire onChangeText but
  // land in inputRef) — takes the normal path, so fresh measurements for
  // long inserted text are never swallowed and the box can't get stuck at
  // the floor with scrolled content.
  const clearedRef = useRef(false)
  const clearComposer = useCallback(() => {
    clearedRef.current = true
    setInput("")
    setComposerHeight(null)
    fieldRef.current?.setNativeProps({ selection: { start: 0, end: 0 } })
  }, [])

  // AI sheet must open AFTER the keyboard is gone: expanding while the
  // composer holds focus leaves only the backdrop visible (the sheet never
  // measures against the keyboard-resized layout). Blur + dismiss first,
  // then expand once keyboardDidHide lands — with a fallback timer (~150ms
  // Android / ~100ms iOS) and a next-tick fast path when the keyboard is
  // already hidden. Pending flag guards double-tap; timer/listener are
  // cleaned on unmount. Keeps the parent-owned sheetRef contract untouched.
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

  // User-typed text closes the stale-measurement window immediately (even
  // before its render commits, so a contentSize racing ahead of the render
  // still takes the normal path). Clearing to empty keeps it open — the
  // manual backspace-to-empty case behaves like a programmatic clear.
  const handleChangeText = useCallback((text: string) => {
    clearedRef.current = text.length === 0
    setSlashHidden(false)
    setInput(text)
  }, [])

  // Outbox auto-flush bookkeeping (see the effect below): refs live next to
  // the queue callbacks since handleUpdateQueued resets the parked head.
  // wasBusyRef tracks the busy → idle transition — the only moment a flush
  // may start. settledHeadRef parks the last attempted head so a failed
  // send is NOT retried in a tight setState loop; it waits for the next
  // busy → idle cycle, a new head, or an explicit edit.
  const wasBusyRef = useRef(false)
  const settledHeadRef = useRef<string | null>(null)

  // Outbox sheet: dismiss the keyboard first (same reason as openAiSheet —
  // expanding against a keyboard-resized layout leaves only the backdrop).
  const openQueueSheet = useCallback(() => {
    fieldRef.current?.blur()
    Keyboard.dismiss()
    requestAnimationFrame(() => queueSheetRef.current?.expand())
  }, [])

  // Stable sheet props: fresh arrays/closures every render would re-render
  // the BottomSheetFlatList on each unrelated update (per streamed token).
  const queueItems = useMemo(
    () => queuedForSession.map((d) => ({ id: d.id, text: d.text || t("session.queue.attachmentFallback") })),
    [queuedForSession, t],
  )
  const handleRemoveQueued = useCallback(
    (queueId: string) => {
      const id = useSessions.getState().currentSession?.id
      if (id) useSessions.getState().removeQueuedMessage(id, queueId)
    },
    [],
  )
  const handleUpdateQueued = useCallback(
    (queueId: string, text: string) => {
      const id = useSessions.getState().currentSession?.id
      if (id) {
        useSessions.getState().updateQueuedMessage(id, queueId, text)
        // The head may have changed content while idle after a failed flush
        // (which parks that head) — allow the fixed text to flush.
        settledHeadRef.current = null
      }
    },
    [],
  )

  // Empty-chat quick action: prefill the composer with the suggestion prompt
  // and focus the field so the user can complete it. Never sends by itself.
  const handleSuggestionPress = useCallback(
    (promptKey: string) => {
      handleChangeText(t(promptKey))
      fieldRef.current?.focus()
    },
    [handleChangeText, t],
  )

  // Slash command handler
  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.type === "builtin") {
        switch (cmd.trigger) {
          case "new":
            router.back()
            return
          case "model":
          case "agent":
            clearComposer()
            openAiSheet()
            return
        }
      }
      setInput(`/${cmd.trigger} `)
    },
    [clearComposer, openAiSheet, router],
  )

  // --- Image picking ---

  // Convert any image (including HEIC/HEIF from iOS) to guaranteed JPEG bytes
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

  const pickFromLibrary = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 1, // full quality - we compress in manipulator
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
    // Try image first
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
    // Fall back to text
    const hasText = await Clipboard.hasStringAsync()
    if (hasText) {
      const text = await Clipboard.getStringAsync()
      if (text) {
        if (input.length + text.length > MAX_COMPOSER_LENGTH) {
          Alert.alert(t("session.alerts.pasteTruncatedTitle"), t("session.alerts.pasteTruncatedMessage"))
        }
        setInput((prev) => prev + text)
        return
      }
    }
    Alert.alert(t("session.alerts.emptyClipboardTitle"), t("session.alerts.emptyClipboardMessage"))
  }, [input, t])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // --- Send ---
  const handleSend = async () => {
    if (!input.trim() && attachments.length === 0) return
    const authenticated = await authenticateForMessage()
    if (!authenticated) {
      Alert.alert(t("session.alerts.authRequiredTitle"), t("session.alerts.authRequiredMessage"))
      return
    }

    const text = input.trim()
    const files = [...attachments]
    setAttachments([])
    // Reset the controlled geometry together with the text — the native
    // measurement doesn't reliably shrink on its own after a clear.
    clearComposer()

    // Server slash commands (no attachments for commands)
    if (text.startsWith("/") && files.length === 0) {
      const [cmdName, ...args] = text.split(" ")
      const name = cmdName.slice(1)
      const match = serverCommands.find((c) => c.name === name)
      if (!match) {
        // Not a known server command — keep the text instead of firing it
        // as a literal prompt.
        setInput(text)
        Alert.alert(t("session.alerts.unknownCommandTitle"), t("session.alerts.unknownCommandMessage"))
        return
      }
      if (sessionClient && currentSession) {
        try {
          await sessionClient.session.command(currentSession.id, {
            command: name,
            arguments: args.join(" "),
            agent,
            model: model ? `${model.providerID}/${model.modelID}` : undefined,
          })
        } catch (err) {
          console.error("Command failed:", err)
          setInput(text)
          Alert.alert(t("session.alerts.sendFailedTitle"), t("session.alerts.sendFailedMessage"))
        }
        return
      }
    }

    // While the agent is busy, follow-ups wait in the client-side outbox
    // and flush FIFO when the session goes idle (see the auto-flush effect
    // below) — instead of hitting the server concurrently.
    if (isSending && currentSession) {
      enqueueMessage(currentSession.id, text, {
        ...(files.length ? { files } : {}),
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
      })
      return
    }

    // Messages are queued server-side when the session is busy.
    // No need to abort - just send and it will be processed after current response.
    try {
      await sendMessage(text, model || undefined, agent || undefined, files, variant || undefined)
    } catch (err) {
      console.error("Send failed:", err)
      // Restore the user's text and attachments so their input isn't lost.
      setInput((prev) => (prev ? prev : text))
      setAttachments((prev) => (prev.length ? prev : files))
      Alert.alert(t("session.alerts.sendFailedTitle"), t("session.alerts.sendFailedMessage"))
    }
  }

  // Auto-flush the outbox: when the session turns idle and something is
  // queued, send the head. Strictly one at a time, in order: the send flips
  // isSending back on, so the next item waits for the following idle.
  //
  // Two guards against update loops (see "Maximum update depth exceeded"):
  // - flush ONLY on the busy → idle transition or when a NEW head appears
  //   (never on every render while idle with a non-empty queue);
  // - a failed head is parked (settledHeadRef) and re-queued at the FRONT
  //   to preserve order, but NOT retried until the next cycle — otherwise a
  //   persistently failing send retries forever, spamming setState + Alert.
  useEffect(() => {
    if (!currentSession) return
    if (isSending) {
      wasBusyRef.current = true
      return
    }
    if (queuedForSession.length === 0) {
      wasBusyRef.current = false
      settledHeadRef.current = null
      return
    }
    const head = queuedForSession[0]
    const shouldFlush = wasBusyRef.current || head.id !== settledHeadRef.current
    wasBusyRef.current = false
    if (!shouldFlush) return
    settledHeadRef.current = head.id
    const next = useSessions.getState().takeNextQueued(currentSession.id)
    if (!next) return
    const sessionID = currentSession.id
    sendMessage(next.text, next.model ?? model ?? undefined, next.agent ?? agent ?? undefined, next.files, next.variant ?? variant ?? undefined)
      .catch((err) => {
        console.error("Queued send failed:", err)
        // Put it back at the FRONT so order is preserved and nothing is lost.
        // No immediate retry: settledHeadRef already parks this head, so the
        // effect above skips it until the next busy → idle cycle.
        useSessions.setState((state) => ({
          queue: { ...state.queue, [sessionID]: [next, ...(state.queue[sessionID] ?? [])] },
        }))
        Alert.alert(t("session.alerts.sendFailedTitle"), t("session.alerts.sendFailedMessage"))
      })
    // sendMessage/model/agent/variant are stable enough per render; the flush
    // re-runs when isSending flips or the queue identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSending, currentSession?.id, queuedForSession, t])

  // In inverted mode, offset 0 = bottom. Show scroll button when scrolled away from bottom.
  const handleScroll = useCallback((event: any) => {
    const { contentOffset } = event.nativeEvent
    setShowScrollButton(contentOffset.y > 200)
  }, [])

  // Debounce: onEndReached can fire multiple times during a single scroll gesture
  const loadingTriggered = useRef(false)
  const handleLoadMore = useCallback(() => {
    if (hasMore && !loadingMore && !loadingTriggered.current) {
      loadingTriggered.current = true
      loadOlderMessages()
    }
  }, [hasMore, loadingMore, loadOlderMessages])

  // Reset trigger when loading finishes
  useEffect(() => {
    if (!loadingMore) loadingTriggered.current = false
  }, [loadingMore])

  // Detect reconnecting → stable transition for the "Connected ✓" flash.
  // reconnectAttempts and lastDisconnectAt reset in the same set() call, so we
  // can't use lastDisconnectAt alone; a useRef tracks the prior reconnecting state.
  useEffect(() => {
    const isReconnecting = reconnectAttempts > 0
    if (prevReconnecting.current && !isReconnecting) {
      setShowConnectedFlash(true)
      const t = setTimeout(() => setShowConnectedFlash(false), 2000)
      return () => clearTimeout(t)
    }
    prevReconnecting.current = isReconnecting
  }, [reconnectAttempts])

  const handlePermissionReply = async (requestID: string, reply: "once" | "always" | "reject") => {
    if (!sessionClient || !sessionID) return
    // Optimistic removal + rollback live inside the mutation; a rejection
    // here only surfaces the retry alert.
    try {
      await permissionMutation.mutateAsync({ client: sessionClient, sessionID, requestID, reply })
    } catch (err) {
      console.error("Permission reply failed:", err)
      Alert.alert(t("session.alerts.replyFailedTitle"), t("session.alerts.replyFailedMessage"))
    }
  }

  const handleQuestionReply = async (requestID: string, answers: string[][]) => {
    if (!sessionClient || !sessionID) return
    try {
      await questionMutation.mutateAsync({ client: sessionClient, sessionID, requestID, answers })
    } catch (err) {
      console.error("Question reply failed:", err)
      Alert.alert(t("session.alerts.replyFailedTitle"), t("session.alerts.replyFailedMessage"))
    }
  }

  const handleQuestionReject = async (requestID: string) => {
    if (!sessionClient || !sessionID) return
    try {
      await questionRejectMutation.mutateAsync({ client: sessionClient, sessionID, requestID })
    } catch (err) {
      console.error("Question reject failed:", err)
      Alert.alert(t("session.alerts.rejectFailedTitle"), t("session.alerts.rejectFailedMessage"))
    }
  }

  // Summary label for the single AI settings button ("agent • model")
  const aiSummary = `${agent || "build"} • ${model?.modelID ? model.modelID.split("/").pop() || model.modelID : "default"}`

  // Follow-up quick actions: same items/style as the empty-chat suggestions,
  // but as a 45px horizontal strip above the composer. Visible when the chat
  // is non-empty and the agent is idle — i.e. right after it finishes working
  // (isSending flips back to false) — hidden while it is busy or loading.
  const showFollowUps = !isLoading && !isSending && messageData.length > 0

  // Active permission/question prompts cover the composer via the dock
  // overlay (see promptOverlay below) instead of unmounting it: the input,
  // quick actions and drafts stay mounted underneath and come back
  // automatically once the prompt is answered/dismissed.
  const hasActivePrompt = permissions.length > 0 || questions.length > 0

  // Variants for current model (for reasoning effort picker)
  const currentModelVariants = useMemo(() => {
    if (!model) return undefined
    const provider = providers.find((p) => p.id === model.providerID)
    const found = provider?.models.find((m) => m.id === model.modelID)
    return found?.variants
  }, [model, providers])

  // Memoized header options: expo-router's StackScreen forwards `options` by
  // identity into a layout-effect setOptions call — an inline literal would
  // fire setOptions on EVERY render (e.g. per streamed token), and the
  // resulting navigation-state update re-renders this screen with fresh
  // options again ("Maximum update depth exceeded", Screen → setOptions).
  // Only real changes (title/dir/focus/theme) may produce a new object.
  const screenTitle = currentSession?.title || t("session.titleFallback")
  const headerRight = useCallback(() => {
    return (
      <View style={s.headerRight}>
        <TouchableOpacity onPress={() => setShowInfo((v) => !v)} hitSlop={8}>
          <Ionicons
            name={showInfo ? "stats-chart" : "stats-chart-outline"}
            size={20}
            color={showInfo ? "#FF2A7A" : isDark ? "#888888" : "#666666"}
          />
        </TouchableOpacity>
      </View>
    )
  }, [showInfo, isDark])
  const screenOptions = useMemo(
    () => ({ title: screenTitle, headerRight }),
    [screenTitle, headerRight],
  )

  return (
    <>
      <Stack.Screen options={screenOptions} />

      <KeyboardAvoidingView
        style={[s.container, isDark && s.containerDark]}
        // Both platforms use "padding" so the composer/toolbar is pushed up
        // above the keyboard via JS-measured keyboard height.
        //
        // Android previously relied on the native android:windowSoftInputMode
        // (adjustResize, see AndroidManifest.xml) with behavior={undefined}
        // to let the OS resize the window (see #70/#53). Since adopting
        // Expo's mandatory edge-to-edge display, Android no longer resizes
        // the window when the keyboard opens — the system assumes insets are
        // handled dynamically — so adjustResize became a no-op and the
        // bottom toolbar + input were left completely hidden behind the
        // keyboard (#147). "padding" restores avoidance without depending
        // on native resize.
        behavior="padding"
        keyboardVerticalOffset={keyboardVerticalOffset(Platform.OS, insets.top)}
      >
        {/* Session info pulldown */}
        <SessionInfo
          session={currentSession}
          messages={messages || []}
          providers={providers}
          visible={showInfo}
          isDark={isDark}
          hasMore={hasMore}
          loadingAll={loadingMore}
          onLoadAll={() => {
            if (hasMore && !loadingMore) loadOlderMessages()
          }}
          onScrollToTop={() => {
            flatListRef.current?.scrollToEnd({ animated: true })
          }}
          onClose={() => setShowInfo(false)}
        />

        {/* SSE reconnect/connected banner */}
        {reconnectAttempts > 0 && (
          <View style={[s.banner, s.bannerReconnecting]}>
            <Text style={s.bannerText}>{t("session.banners.reconnecting", { attempt: reconnectAttempts })}</Text>
          </View>
        )}
        {showConnectedFlash && reconnectAttempts === 0 && (
          <View style={[s.banner, s.bannerConnected]}>
            <Text style={s.bannerText}>{t("session.banners.connected")}</Text>
          </View>
        )}

        {/* Pending revert (from "Edit message") — offer a way back before it's
            cleaned up by the next prompt. */}
        {revertMessageID && (
          <View style={[s.banner, s.bannerRevert]}>
            <Text style={s.bannerText}>{t("session.banners.reverted")}</Text>
              <TouchableOpacity
                onPress={() => {
                  // Clear the composer only after the server confirms the
                  // unrevert — on failure the prefilled draft must survive.
                  unrevertMutation.mutate(undefined, {
                    onSuccess: () => {
                      // The composer was prefilled with the reverted message's text/
                      // attachments (see applyRevertResult) — clear it so Undo doesn't
                      // leave a stale draft that could be sent as a duplicate.
                      setAttachments([])
                      clearComposer()
                    },
                  })
                }}
                hitSlop={8}
              >
              <Text style={s.bannerAction}>{t("session.banners.undo")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {isLoading ? (
          <View style={s.loading}>
            <ActivityIndicator size="large" color={isDark ? "#ffffff" : "#0a0a0a"} />
          </View>
        ) : (
          <View style={s.listWrap}>
            <FlatList
              ref={flatListRef}
              data={messageData}
              inverted
              keyExtractor={(item) => item.message.id}
              renderItem={({ item }) => (
                <MessageBubble
                  message={item.message}
                  parts={item.parts}
                  isDark={isDark}
                  onLongPress={handleMessageLongPress}
                />
              )}
              // Список инвертирован: верх контентных координат = визуальный низ,
              // поэтому запас под док даём через paddingTop.
              contentContainerStyle={[s.messageList, { paddingTop: 16 + dockHeight }]}
              onScroll={handleScroll}
              scrollEventThrottle={100}
              onEndReached={handleLoadMore}
              onEndReachedThreshold={0.5}
              // Prevent jump when older messages are prepended
              maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              ListHeaderComponent={
                currentSession ? (
                  <StatusIndicator
                    status={statusForScroll}
                    statusText={statusTextForScroll}
                    optimistic={optimisticSending}
                    isDark={isDark}
                  />
                ) : null
              }
              ListFooterComponent={
                loadingMore ? (
                  <View style={s.loadingMore}>
                    <ActivityIndicator size="small" color={isDark ? "#888888" : "#666666"} />
                    <Text style={[s.loadingMoreText, isDark && s.metaDark]}>{t("session.loadingOlder")}</Text>
                  </View>
                ) : null
              }
            />
            {/* Empty state rendered OUTSIDE the inverted list to avoid the
                inverted transform mirroring its text/icon (see #ui-mirror).
                box-none: taps pass through the overlay itself, chips stay tappable. */}
            {messageData.length === 0 && (
              <View style={s.emptyOverlay} pointerEvents="box-none">
                <Ionicons name="chatbubble-outline" size={48} color={isDark ? "#444444" : "#cccccc"} />
                <Text style={[s.emptyText, isDark && s.metaDark]}>{t("session.empty.suggestionsTitle")}</Text>
                <View style={s.suggestionsWrap}>
                  {SUGGESTIONS.map((item) => (
                    <TouchableOpacity
                      key={item.key}
                      style={[s.suggestionChip, isDark && s.suggestionChipDark]}
                      onPress={() => handleSuggestionPress(item.promptKey)}
                      testID={`suggestion-${item.key}`}
                      accessibilityRole="button"
                      accessibilityLabel={t(item.labelKey)}
                    >
                      <Ionicons
                        name={item.icon as keyof typeof Ionicons.glyphMap}
                        size={16}
                        color={isDark ? "#bbbbbb" : "#444444"}
                      />
                      <Text style={[s.suggestionText, isDark && s.suggestionTextDark]}>{t(item.labelKey)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={[s.emptyHint, isDark && s.metaDark]}>{t("session.empty.hint")}</Text>
              </View>
            )}
            {showScrollButton && (
              <TouchableOpacity
                style={[s.scrollBtn, isDark && s.scrollBtnDark, { bottom: 16 + dockHeight }]}
                onPress={() => scrollToBottom(true)}
              >
                <Ionicons name="chevron-down" size={24} color={isDark ? "#ffffff" : "#0a0a0a"} />
              </TouchableOpacity>
            )}
            {/* Подложка палитры команд: пока палитра открыта, перехватывает
                все тапы/скроллы мимо неё — иначе скроллится список сообщений
                под палитрой. Тап закрывает палитру (текст цел), палитра в доке
                рисуется выше (zIndex дока 2), скролл внутри неё работает. */}
            {slashActive && (
              <Pressable
                style={s.slashBackdrop}
                onPress={() => setSlashHidden(true)}
                testID="slash-backdrop"
                accessibilityRole="button"
                accessibilityLabel={t("session.actions.closeCommands")}
              />
            )}
          </View>
        )}

        {/* Нижний док: квик-действия + ввод (+ аттачменты, когда видны) —
            fixed overlay поверх чата. Высота замеряется (onLayout) и уходит
            в отступ списка, клавиатура поднимает док через bottom.
            Промпты (permission/question) — absolute-оверлей поверх дока. */}
        <View
          style={[s.dock, isDark && s.dockDark, { bottom: keyboardH, paddingBottom: Math.max(12, insets.bottom) }]}
          onLayout={(e) => setDockHeight(e.nativeEvent.layout.height)}
        >
        {/* Затемнение под доком: полупрозрачный градиент сверху вниз
            (прозрачный → 55% чёрного в тёмной теме / 90% белого в светлой,
            в цвет фона). Лежит absolute-подложкой: контент дока
            рисуется поверх, тапы сквозь (pointerEvents none), на layout не влияет. */}
        <LinearGradient
          colors={
            isDark
              ? (["rgba(0,0,0,0)", "rgba(0,0,0,0.55)"] as const)
              : (["rgba(255,255,255,0)", "rgba(255,255,255,0.9)"] as const)
          }
          style={s.dockGradient}
          pointerEvents="none"
        />
        {/* Промпты поверх ввода: absolute-overlay на весь док (zIndex/elevation 5
            выше поля и кнопок) со сплошным фоном в цвет экрана — поле ввода,
            квик-действия и поповеры остаются смонтированы под ним, но не видны
            и недоступны для тапов. После ответа/отклонения оверлей исчезает и
            ввод «возвращается» сам (драфт цел, размонтирования не было).
            Absolute-позиция не участвует в замере dockHeight — список не прыгает. */}
        {hasActivePrompt && (
          <View
            style={[
              s.promptOverlay,
              isDark && s.promptOverlayDark,
              {
                paddingBottom: Math.max(12, insets.bottom),
                maxHeight: Math.round(windowHeight * 0.6),
              },
            ]}
          >
            {permissions.map((perm) => (
              <PermissionPrompt
                key={perm.id}
                permission={perm}
                isDark={isDark}
                onReply={(reply) => handlePermissionReply(perm.id, reply)}
              />
            ))}
            {questions.map((q) => (
              <QuestionPrompt
                key={q.id}
                request={q}
                isDark={isDark}
                onReply={(answers) => handleQuestionReply(q.id, answers)}
                onReject={() => handleQuestionReject(q.id)}
              />
            ))}
          </View>
        )}

        {/* Attachment preview */}
        <ImageAttachments attachments={attachments} isDark={isDark} onRemove={removeAttachment} />

        {/* Outbox: queued follow-ups waiting for idle */}
        {queuedForSession.length > 0 && (
          <View style={s.queueBar}>
            <TouchableOpacity
              style={[s.queueBtn, isDark && s.queueBtnDark]}
              onPress={openQueueSheet}
              testID="message-queue-button"
              accessibilityRole="button"
              accessibilityLabel={t("session.queue.button", { count: queuedForSession.length })}
            >
              <Ionicons name="time-outline" size={15} color={isDark ? "#bbbbbb" : "#444444"} />
              <Text style={[s.queueBtnText, isDark && s.queueBtnTextDark]}>
                {t("session.queue.button", { count: queuedForSession.length })}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Follow-up quick actions (after the agent finishes) */}
        {showFollowUps && (
          <View style={[s.followUpBar, isDark && s.followUpBarDark]}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.followUpScroll}
              contentContainerStyle={s.followUpContent}
            >
              {SUGGESTIONS.map((item) => (
                <TouchableOpacity
                  key={item.key}
                  style={[s.followUpChip, isDark && s.followUpChipDark]}
                  onPress={() => handleSuggestionPress(item.promptKey)}
                  testID={`followup-${item.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={t(item.labelKey)}
                >
                  <Ionicons
                    name={item.icon as keyof typeof Ionicons.glyphMap}
                    size={13}
                    color={isDark ? "#bbbbbb" : "#444444"}
                  />
                  <Text style={[s.followUpText, isDark && s.followUpTextDark]}>{t(item.labelKey)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Input */}
        <View style={[s.inputContainer, isDark && s.inputContainerDark]}>
          <View style={s.inputRow}>
            {/* Список команд: absolute-оверлей, заходит за поле ввода
                (низ палитры прячется под полем — выходит из-под блока ввода),
                растёт вверх поверх быстрых действий. В замере dockHeight не участвует. */}
            {slashActive && (
              <View style={[s.slashWrap, { paddingBottom: Math.max(0, composerFieldHeight - 16) }]}>
                <SlashPopover query={slashQuery} commands={allCommands} isDark={isDark} onSelect={handleSlashSelect} />
              </View>
            )}
            <TextInput
              ref={fieldRef}
              style={[
                s.input,
                isDark && s.inputDark,
                speech.listening && s.inputListening,
                { height: composerFieldHeight },
              ]}
              placeholder={
                speech.listening
                  ? t("session.input.placeholderListening")
                  : isSending
                    ? t("session.input.placeholderFollowUp")
                    : t("session.input.placeholderDefault")
              }
              placeholderTextColor={speech.listening ? "#ef4444" : isDark ? "#666666" : "#999999"}
              value={speech.listening ? speech.transcript : input}
              onChangeText={speech.listening ? undefined : handleChangeText}
              onContentSizeChange={(e) => {
                // Stale-window gate (see clearComposer): a contentSize event
                // landing after a clear while the committed text is still
                // empty is a pre-clear echo — ignore it so it can't resurrect
                // a tall box or poison the floor. Empty then always means the
                // minimum height (the null set below bails out without a
                // render when already null, so this can't loop).
                // Voice transcripts render through `value` while `input` stays
                // empty, so listening mode is exempt — the transcript must
                // keep growing the box.
                if (!speech.listening && clearedRef.current && !inputRef.current) {
                  setComposerHeight(null)
                  return
                }
                setComposerHeight(e.nativeEvent.contentSize.height)
              }}
              editable={!speech.listening}
              multiline
              scrollEnabled
              maxLength={MAX_COMPOSER_LENGTH}
              testID="chat-message-input"
            />
            {/* Overlay control bar: bottom row over the input.
                box-none lets taps outside the buttons fall through to the field. */}
            <View style={s.overlayBtns} pointerEvents="box-none">
              <View style={s.overlayGroup}>
                {!speech.listening && (
                  <TouchableOpacity style={s.overlayBtn} onPress={pickFromLibrary} onLongPress={pickFromCamera}>
                    <Ionicons name="add-circle-outline" size={24} color={isDark ? "#888888" : "#666666"} />
                  </TouchableOpacity>
                )}
                {!speech.listening && (
                  <TouchableOpacity
                    style={s.overlayBtn}
                    onPress={openAiSheet}
                    testID="ai-settings-button"
                    accessibilityLabel={aiSummary}
                  >
                    <Ionicons name="options-outline" size={24} color={isDark ? "#888888" : "#666666"} />
                  </TouchableOpacity>
                )}
              </View>
              <View style={s.overlayGroup}>
                {!isSending && !input.trim() && attachments.length === 0 && !speech.listening && (
                  <TouchableOpacity
                    style={s.overlayBtn}
                    onPress={speech.start}
                    accessibilityLabel={t("session.actions.mic")}
                  >
                    <Ionicons name="mic" size={24} color={isDark ? "#888888" : "#666666"} />
                  </TouchableOpacity>
                )}
                {speech.listening && (
                  <TouchableOpacity style={s.overlayBtn} onPress={speech.stop}>
                    <Ionicons name="mic" size={24} color="#ef4444" />
                  </TouchableOpacity>
                )}
                {/* Stop button: only when busy and no input */}
                {isSending && !input.trim() && attachments.length === 0 && !speech.listening && (
                  <TouchableOpacity
                    style={s.overlayBtn}
                    onPress={() => abortMutation.mutate()}
                    accessibilityLabel={t("session.actions.stop")}
                  >
                    <Ionicons name="stop" size={24} color="#ef4444" />
                  </TouchableOpacity>
                )}
                {/* Send button: when there's input */}
                {!speech.listening && (input.trim() || attachments.length > 0) && (
                  <TouchableOpacity
                    style={s.overlayBtn}
                    onPress={handleSend}
                    testID="chat-send-button"
                    accessibilityLabel={t("session.actions.send")}
                  >
                    <Ionicons name="send" size={24} color={isDark ? "#ffffff" : "#0a0a0a"} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        </View>
        </View>
      </KeyboardAvoidingView>

      {/* AI settings dialog (agent + model + reasoning effort).
          Layer wrapper: gorhom renders inline (not a portal), so without an
          explicit stacking level the composer overlay buttons (zIndex: 1) and
          the scroll-to-bottom button (Android elevation 4) bleed through the
          open sheet and its backdrop. box-none keeps list touches working
          while the sheet is closed (index -1). */}
      <View style={s.sheetLayer} pointerEvents="box-none">
      <AiSettingsModal
        sheetRef={aiSheetRef}
        agents={agents}
        selectedAgent={agent}
        providers={providers}
        selectedModel={model}
        variants={currentModelVariants}
        selectedVariant={variant}
        isDark={isDark}
        onSelectAgent={setAgent}
        onSelectModel={(providerID, modelID) => setModel({ providerID, modelID })}
        onSelectVariant={setVariant}
      />
      <MessageQueueSheet
        sheetRef={queueSheetRef}
        items={queueItems}
        isDark={isDark}
        onRemove={handleRemoveQueued}
        onUpdate={handleUpdateQueued}
        testID="message-queue-sheet"
      />
      </View>
    </>
  )
}

// Uniform composer spacing: container padding and the input's top/side insets.
const COMPOSER_PADDING = 12

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  loading: { flex: 1, justifyContent: "center", alignItems: "center" },
  listWrap: { flex: 1, position: "relative" },

  // Messages
  messageList: { padding: 16, paddingBottom: 8 },

  // Scroll button
  scrollBtn: {
    position: "absolute",
    bottom: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ffffff",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  scrollBtnDark: { backgroundColor: "#2a2a2a" },

  // Loading more (appears at top in inverted list = ListFooterComponent)
  loadingMore: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingVertical: 16,
  },
  loadingMoreText: { fontSize: 13, color: "#999999" },

  // Empty state overlay — sits on top of the (empty) inverted list, untransformed,
  // so its text/icon render upright and un-mirrored on Android.
  emptyOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 64,
    paddingHorizontal: 24,
  },

  // Empty
  empty: { flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 64 },
  emptyText: { fontSize: 16, color: "#999999", marginTop: 12 },
  // Quick-action chips: web flex-wrap analog — row + wrap so chips flow onto
  // the next line instead of stacking vertically.
  suggestionsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
  },
  suggestionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#f5f5f5",
  },
  suggestionChipDark: { borderColor: "#2a2a2a", backgroundColor: "#1a1a1a" },
  suggestionText: { fontSize: 14, fontWeight: "500", color: "#444444" },
  suggestionTextDark: { color: "#bbbbbb" },
  // Follow-up strip above the composer: fixed 45px block, horizontal scroll.
  // Chips mirror suggestionChip (border + background) in a compact form to
  // fit the 45px height.
  // No dividers, transparent background — the strip floats over the list.
  followUpBar: {
    height: 45,
    justifyContent: "center",
    // Same inset as the composer field; chips start flush at the bar edge —
    // spacing lives only between chips (gap in followUpContent), not around.
    marginHorizontal: COMPOSER_PADDING,
    backgroundColor: "transparent",
  },
  followUpBarDark: { backgroundColor: "transparent" },
  followUpScroll: { height: 45 },
  followUpContent: {
    flexDirection: "row",
    alignItems: "center",
    // Только gap между чипами — без полей вокруг кнопок по краям скролла.
    gap: 8,
    height: 45,
  },
  followUpChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#f5f5f5",
  },
  followUpChipDark: { borderColor: "#2a2a2a", backgroundColor: "#1a1a1a" },
  followUpText: { fontSize: 12, fontWeight: "500", color: "#444444" },
  followUpTextDark: { color: "#bbbbbb" },
  // Outbox button row above the composer: compact, same chip language.
  queueBar: {
    flexDirection: "row",
    justifyContent: "center",
    marginHorizontal: COMPOSER_PADDING,
    marginBottom: 8,
  },
  queueBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#f5f5f5",
  },
  queueBtnDark: { borderColor: "#2a2a2a", backgroundColor: "#1a1a1a" },
  queueBtnText: { fontSize: 13, fontWeight: "600", color: "#444444" },
  queueBtnTextDark: { color: "#bbbbbb" },
  emptyHint: { fontSize: 13, color: "#bbbbbb", marginTop: 12 },
  metaDark: { color: "#666666" },
  textWhite: { color: "#ffffff" },

  // Input
  // Нижний док — fixed overlay поверх чата (квик-действия + ввод).
  // Фон прозрачный: черты нет, контейнеры не перекрывают список плашкой.
  // Высота дока замеряется (onLayout) и уходит в отступ списка.
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "transparent",
    zIndex: 2,
    elevation: 0,
  },
  dockDark: { backgroundColor: "transparent" },
  // Оверлей промптов (permission/question): перекрывает весь док поверх ввода
  // и квик-действий. Сплошной фон в цвет экрана прячет поле под собой, тапы
  // ловит сам (контент под ним недоступен, но не размонтирован). maxHeight
  // задаётся инлайном от высоты окна — длинные вопросы скроллятся внутри
  // QuestionPrompt, а не разъезжаются на весь экран.
  promptOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5,
    elevation: 5,
    justifyContent: "flex-end",
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderColor: "#e5e5e5",
  },
  promptOverlayDark: { backgroundColor: "#0a0a0a", borderColor: "#2a2a2a" },
  dockGradient: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // Тянем градиент выше верхней кромки дока, чтобы затемнение начиналось
    // плавно над квик-действиями, а не резкой чертой по их верху.
    top: -40,
  },
  inputContainer: {
    padding: COMPOSER_PADDING,
    backgroundColor: "transparent",
  },
  inputContainerDark: { backgroundColor: "transparent" },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  // Список команд: обёртка якорится к низу строки ввода (bottom: 0) и
  // продлена вниз на высоту поля (paddingBottom = высота поля − 16):
  // блок заходит за поле ввода, а палитра выходит из-под него — низ
  // поповера (~16px) прячется за непрозрачным полем (поле выше по z).
  // Растёт вверх поверх быстрых действий. В замере dockHeight не участвует.
  slashWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: 340,
    zIndex: 0,
    elevation: 0,
  },
  // Подложка открытой палитры: прозрачная, на весь список (zIndex 1 выше
  // FlatList, ниже дока zIndex 2) — перехватывает тапы/скроллы мимо палитры.
  slashBackdrop: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
  overlayBtns: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 2,
  },
  overlayGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  overlayBtn: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  // Composer spacing — single value for container padding and the input's
  // top/side insets so the field spans full width uniformly.
  input: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    borderRadius: 20,
    // Обводка как у карточек проекта (projectCard): синхронно с дизайном.
    borderWidth: 1,
    borderColor: "#e5e5e5",
    // Поле непрозрачно перекрывает низ палитры команд (slashWrap zIndex 0):
    // так палитра визуально выходит из-под блока ввода.
    zIndex: 1,
    elevation: 1,
    paddingTop: COMPOSER_PADDING,
    paddingBottom: 52,
    paddingLeft: COMPOSER_PADDING,
    paddingRight: COMPOSER_PADDING,
    fontSize: 16,
    minHeight: COMPOSER_MIN_HEIGHT,
    maxHeight: 240,
    color: "#0a0a0a",
  },
  inputDark: { backgroundColor: "#1a1a1a", color: "#ffffff", borderColor: "#2a2a2a" },
  inputListening: { borderWidth: 1, borderColor: "#ef4444" },

  // Header
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },

  // SSE reconnect/connected banner
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: "center",
  },
  bannerReconnecting: { backgroundColor: "#92400e" },
  bannerConnected: { backgroundColor: "#065f46" },
  bannerText: { color: "#ffffff", fontSize: 13, fontWeight: "500" },

  // Pending revert (edit message) banner
  bannerRevert: {
    backgroundColor: "#7A1E43",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  bannerAction: { color: "#FFB199", fontSize: 13, fontWeight: "700" },

  // Bottom-sheet layer: must sit above the composer overlay buttons and the
  // scroll button (see wrapper comment at the AiSettingsModal usage). No
  // backgroundColor — so Android draws no shadow from the elevation.
  sheetLayer: {
    ...StyleSheet.absoluteFill,
    zIndex: 10,
    elevation: 10,
  },
})
