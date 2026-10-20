import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Keyboard, type FlatList } from "react-native"
import type BottomSheet from "@gorhom/bottom-sheet"
import type { TFunction } from "i18next"
import type { EdgeInsets } from "react-native-safe-area-context"
import { useSessions, type QueuedDraft } from "@/stores/sessions"
import { useAuth } from "@/stores/auth"
import { useEvents, type PermissionRequest, type QuestionRequest } from "@/stores/events"
import { useConnections } from "@/stores/connections"
import { useCatalog } from "@/stores/catalog"
import { useCatalogData } from "@/api/catalog"
import { useComposer } from "../../utils/composer"
import { useRevertFlow } from "../../utils/revert-flow"
import { useSessionAlerts } from "../../utils/session-alerts"
import { useReconnectFlash } from "../../utils/reconnect-flash"
import { useOutboxFlush } from "../../utils/outbox-flush"
import { useSlashState } from "../../utils/slash-state"
import { useSpeech } from "../../utils/speech"
import { useAiSheet } from "../use-ai-sheet"
import { useKeyboardDock } from "../use-keyboard-dock"
import { useSessionSend } from "../use-session-send"
import { useSessionPrompts } from "../use-session-prompts"
import {
  useAbortSession,
  useRevertSession,
  useUnrevertSession,
  usePermissionReply,
  useQuestionReply,
  useQuestionReject,
} from "@/api/session-ops"
import type { Agent, Client, Message, Part } from "../../utils/sdk"
import type { Provider } from "../../utils/catalog-parse"
import type { ListedSession } from "../../utils/listed-session"
import type { StatusSnapshot } from "@web2bizz/ui-native"
import type {
  SessionHeaderProps,
  SessionBannersProps,
  MessageListProps,
  ComposerDockProps,
  PromptOverlayProps,
  SessionSheetsProps,
} from "@/components/session"

export type SessionScreenData = {
  currentSession: ListedSession | null
  messages: Message[]
  parts: Record<string, Part[]>
  isLoading: boolean
  loadingMore: boolean
  hasMore: boolean
  sendMessage: (
    text: string,
    model?: { providerID: string; modelID: string },
    agent?: string,
    files?: Array<{ uri: string; mime: string; filename?: string; base64?: string }>,
    variant?: string,
  ) => Promise<void>
  loadOlderMessages: () => Promise<void>
  optimisticSending: boolean
  queuedForSession: QueuedDraft[]
  enqueueMessage: (
    sessionID: string,
    text: string,
    opts?: Pick<QueuedDraft, "files" | "model" | "agent" | "variant">,
  ) => QueuedDraft
  isSending: boolean
  statusForScroll: StatusSnapshot | undefined
  statusTextForScroll: string | undefined
  sessionClient: Client | null
  agents: Agent[]
  serverCommands: { name: string; description?: string }[]
  providers: Provider[]
  agent: string
  model: { providerID: string; modelID: string } | null
  variant: string | null
  setModel: (selection: { providerID: string; modelID: string } | null) => void
  setVariant: (variant: string | null) => void
  setAgent: (name: string) => void
  sessionID: string | undefined
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  revertMessageID: string | undefined
  messageData: { message: Message; parts: Part[] }[]
  reconnectAttempts: number
  currentModelVariants: Record<string, { reasoningEffort?: string }> | undefined
  aiSummary: string
  showFollowUps: boolean
  hasActivePrompt: boolean
}

// Shared stable empty queue: the per-session selector below must not mint a
// fresh `[]` on every store notification (new reference = re-render and new
// downstream props on every unrelated update, e.g. per streamed token).
const EMPTY_QUEUE: QueuedDraft[] = []

// Экранные данные сессии: селекторы sending/queue/status, origin-aware
// sessionClient, catalog reseed + селекции, производные messageData/variants/
// aiSummary/showFollowUps/hasActivePrompt. Чистые данные без JSX.
export function useSessionScreenData(): SessionScreenData {
  const {
    currentSession,
    messages,
    parts,
    isLoading,
    loadingMore,
    hasMore,
    sendMessage,
    loadOlderMessages,
  } = useSessions()

  // Busy = optimistic sending flag OR SSE-reported status. The optimistic
  // flag alone is not enough: it only bridges the gap between tap and SSE
  // busy, and a re-entry (useFocusEffect → selectSession) used to clear it —
  // so after leaving and returning to a running chat the Stop button
  // disappeared even though the server was still busy. SSE status persists
  // globally across navigation, so it keeps the button visible.
  const optimisticSending = useSessions((s) => !!(currentSession && s.sending[currentSession.id]))
  const queuedForSession = useSessions((s) =>
    currentSession ? (s.queue[currentSession.id] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
  )
  const enqueueMessage = useSessions((s) => s.enqueueMessage)
  const sseBusy = useEvents(
    (s) => !!currentSession && !!s.sessionStatus[currentSession.id] && s.sessionStatus[currentSession.id].type !== "idle",
  )
  const isSending = optimisticSending || sseBusy

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

  // SSE reconnect banner
  const reconnectAttempts = useEvents((s) => s.reconnectAttempts)

  // Auto-scroll when status appears at bottom of messages (fixed in list)
  const statusForScroll = useEvents((s) => (currentSession ? s.sessionStatus[currentSession.id] : undefined))
  const statusTextForScroll = useEvents((s) => (currentSession ? s.statusText[currentSession.id] : undefined))

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

  // Summary label for the single AI settings button ("agent • model")
  const aiSummary = `${agent || "build"} • ${model?.modelID ? model.modelID.split("/").pop() || model.modelID : "default"}`

  // Follow-up quick actions: same items/style as the empty-chat suggestions,
  // but as a 45px horizontal strip above the composer. Visible when the chat
  // is non-empty and the agent is idle — i.e. right after it finishes working
  // (isSending flips back to false) — hidden while it is busy or loading.
  const showFollowUps = !isLoading && !isSending && messageData.length > 0

  // Active permission/question prompts cover the composer via the dock
  // overlay (see PromptOverlay) instead of unmounting it: the input,
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

  return {
    currentSession,
    messages,
    parts,
    isLoading,
    loadingMore,
    hasMore,
    sendMessage,
    loadOlderMessages,
    optimisticSending,
    queuedForSession,
    enqueueMessage,
    isSending,
    statusForScroll,
    statusTextForScroll,
    sessionClient,
    agents,
    serverCommands,
    providers,
    agent,
    model,
    variant,
    setModel,
    setVariant,
    setAgent,
    sessionID,
    permissions,
    questions,
    revertMessageID,
    messageData,
    reconnectAttempts,
    currentModelVariants,
    aiSummary,
    showFollowUps,
    hasActivePrompt,
  }
}

// Props SessionInfo (uikit): структурный тип для группы info контроллера.
export type SessionInfoProps = {
  session: ListedSession | null
  messages: Message[]
  providers: Provider[]
  visible: boolean
  isDark: boolean
  hasMore: boolean
  loadingAll: boolean
  onLoadAll: () => void
  onScrollToTop: () => void
  onClose: () => void
}

export type SessionController = {
  isLoading: boolean
  hasActivePrompt: boolean
  header: SessionHeaderProps
  info: SessionInfoProps
  banners: SessionBannersProps
  list: MessageListProps
  dock: Omit<ComposerDockProps, "promptOverlay">
  prompts: PromptOverlayProps
  sheets: SessionSheetsProps
}

// Контроллер экрана: владеет единичными инстансами (composer, speech,
// мутации, рефы, outbox-бухгалтерия) и собирает готовые группы пропсов для
// виджетов. Роут только раскладывает их по JSX.
export function useSessionController(t: TFunction, isDark: boolean, insets: EdgeInsets): SessionController {
  const flatListRef = useRef<FlatList>(null)
  const aiSheetRef = useRef<BottomSheet | null>(null)
  const queueSheetRef = useRef<BottomSheet | null>(null)
  // Composer state (input/attachments/height/clear) extracted to a hook.
  const composer = useComposer(t)
  const { input, setInput, attachments, setAttachments, composerHeight, setComposerHeight, clearedRef, fieldRef, inputRef, clearComposer } = composer
  const [showInfo, setShowInfo] = useState(false)
  const toggleInfo = useCallback(() => setShowInfo((v) => !v), [])
  const [showConnectedFlash, setShowConnectedFlash] = useState(false)

  // Экранные данные: sending/queue/status, sessionClient, catalog, messageData.
  const screen = useSessionScreenData()
  const { keyboardY, keyboardH, dockHeight, setDockHeight, composerFieldHeight } = useKeyboardDock(composerHeight)

  // Discrete server ops as React Query mutations (optimistic UI + rollback
  // inside, alerts stay at the call sites).
  const abortMutation = useAbortSession()
  const revertMutation = useRevertSession()
  const unrevertMutation = useUnrevertSession()
  const permissionMutation = usePermissionReply()
  const questionMutation = useQuestionReply()
  const questionRejectMutation = useQuestionReject()

  const { authenticateForMessage } = useAuth()

  // Voice input — transcript appends to the text input on completion
  const speech = useSpeech(
    useCallback((text: string) => {
      setInput((prev) => (prev ? prev + " " + text : text))
    }, []),
  )

  const sessionError = useSessions((s) => s.error)
  const clearSessionError = useSessions((s) => s.clearError)
  useSessionAlerts(speech.error ?? null, sessionError, clearSessionError, t)

  const openAiSheet = useAiSheet(aiSheetRef, fieldRef, keyboardY)

  // Slash commands (allCommands + handleSlashSelect) — needs openAiSheet.
  // Единый источник slash-состояния (вместо бывшего локального slashHidden):
  // handleChangeText сбрасывает его, чтобы палитра открывалась заново.
  const { slashActive, slashQuery, allCommands, handleSlashSelect, setSlashHidden } = useSlashState(
    input,
    screen.serverCommands,
    clearComposer,
    openAiSheet,
    setInput,
  )
  const handleChangeText = useCallback(
    (text: string) => {
      setSlashHidden(false)
      composer.handleChangeText(text)
    },
    [composer],
  )
  const closeSlash = useCallback(() => setSlashHidden(true), [setSlashHidden])

  // Revert (edit message) flow extracted to a hook.
  const { handleMessageLongPress } = useRevertFlow({
    t,
    revertMutation,
    setInput,
    setAttachments,
    clearComposer,
    inputRef,
  })

  // Outbox sheet: dismiss the keyboard first (same reason as openAiSheet —
  // expanding against a keyboard-resized layout leaves only the backdrop).
  const openQueueSheet = useCallback(() => {
    fieldRef.current?.blur()
    Keyboard.dismiss()
    requestAnimationFrame(() => queueSheetRef.current?.expand())
  }, [])

  // Outbox auto-flush bookkeeping (see the effect below): refs live next to
  // the queue callbacks since handleUpdateQueued resets the parked head.
  // wasBusyRef tracks the busy → idle transition — the only moment a flush
  // may start. settledHeadRef parks the last attempted head so a failed
  // send is NOT retried in a tight setState loop; it waits for the next
  // busy → idle cycle, a new head, or an explicit edit.
  // Outbox flush state lives in useOutboxFlush (called below); this ref
  // lets handleUpdateQueued reset the parked head before the hook is wired.
  const resetSettledRef = useRef<() => void>(() => {})

  // Stable sheet props: fresh arrays/closures every render would re-render
  // the BottomSheetFlatList on each unrelated update (per streamed token).
  const queueItems = useMemo(
    () => screen.queuedForSession.map((d) => ({ id: d.id, text: d.text || t("session.queue.attachmentFallback") })),
    [screen.queuedForSession, t],
  )
  const handleRemoveQueued = useCallback((queueId: string) => {
    const id = useSessions.getState().currentSession?.id
    if (id) useSessions.getState().removeQueuedMessage(id, queueId)
  }, [])
  const handleUpdateQueued = useCallback((queueId: string, text: string) => {
    const id = useSessions.getState().currentSession?.id
    if (id) {
      useSessions.getState().updateQueuedMessage(id, queueId, text)
      // The head may have changed content while idle after a failed flush
      // (which parks that head) — allow the fixed text to flush.
      resetSettledRef.current()
    }
  }, [])

  // Outbox auto-flush extracted to a hook.
  const outbox = useOutboxFlush({
    currentSession: screen.currentSession,
    isSending: screen.isSending,
    queuedForSession: screen.queuedForSession,
    sendMessage: screen.sendMessage,
    model: screen.model,
    agent: screen.agent,
    variant: screen.variant,
    t,
  })
  resetSettledRef.current = outbox.resetSettled

  const { handlePermissionReply, handleQuestionReply, handleQuestionReject } = useSessionPrompts({
    sessionClient: screen.sessionClient,
    sessionID: screen.sessionID,
    permissionMutation,
    questionMutation,
    questionRejectMutation,
    t,
  })

  const handleSend = useSessionSend({
    input,
    attachments,
    setAttachments,
    clearComposer,
    setInput,
    serverCommands: screen.serverCommands,
    sessionClient: screen.sessionClient,
    currentSession: screen.currentSession,
    agent: screen.agent,
    model: screen.model,
    variant: screen.variant,
    isSending: screen.isSending,
    enqueueMessage: screen.enqueueMessage,
    sendMessage: screen.sendMessage,
    authenticateForMessage,
    t,
  })

  useReconnectFlash(screen.reconnectAttempts, setShowConnectedFlash)

  const screenTitle = screen.currentSession?.title || t("session.titleFallback")

  return {
    isLoading: screen.isLoading,
    hasActivePrompt: screen.hasActivePrompt,
    header: { title: screenTitle, showInfo, isDark, onToggleInfo: toggleInfo },
    info: {
      session: screen.currentSession,
      messages: screen.messages || [],
      providers: screen.providers,
      visible: showInfo,
      isDark,
      hasMore: screen.hasMore,
      loadingAll: screen.loadingMore,
      onLoadAll: () => {
        if (screen.hasMore && !screen.loadingMore) screen.loadOlderMessages()
      },
      onScrollToTop: () => {
        flatListRef.current?.scrollToEnd({ animated: true })
      },
      onClose: () => setShowInfo(false),
    },
    banners: {
      reconnectAttempts: screen.reconnectAttempts,
      showConnectedFlash,
      revertMessageID: screen.revertMessageID,
      onUndoRevert: () => {
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
      },
      t,
    },
    list: {
      messageData: screen.messageData,
      status: screen.statusForScroll,
      statusText: screen.statusTextForScroll,
      optimisticSending: screen.optimisticSending,
      isDark,
      hasMore: screen.hasMore,
      loadingMore: screen.loadingMore,
      dockHeight,
      slashActive,
      showStatus: !!screen.currentSession,
      listRef: flatListRef,
      onLongPress: handleMessageLongPress,
      onSuggestion: composer.handleSuggestionPress,
      onCloseSlash: closeSlash,
      onLoadMore: screen.loadOlderMessages,
    },
    dock: {
      isDark,
      keyboardH,
      bottomInset: insets.bottom,
      onDockLayout: setDockHeight,
      attachments,
      onRemoveAttachment: composer.removeAttachment,
      queueCount: screen.queuedForSession.length,
      onOpenQueue: openQueueSheet,
      showFollowUps: screen.showFollowUps,
      onSuggestion: composer.handleSuggestionPress,
      slashActive,
      slashQuery,
      slashCommands: allCommands,
      onSlashSelect: handleSlashSelect,
      composerFieldHeight,
      fieldRef,
      input,
      onChangeText: handleChangeText,
      clearedRef,
      inputRef,
      onMeasureHeight: setComposerHeight,
      speechListening: speech.listening,
      speechTranscript: speech.transcript,
      onMicStart: speech.start,
      onMicStop: speech.stop,
      isSending: screen.isSending,
      onPickLibrary: composer.pickFromLibrary,
      onPickCamera: composer.pickFromCamera,
      onOpenAiSheet: openAiSheet,
      aiSummary: screen.aiSummary,
      onAbort: () => abortMutation.mutate(),
      onSend: handleSend,
      t,
    },
    prompts: {
      permissions: screen.permissions,
      questions: screen.questions,
      isDark,
      onPermissionReply: handlePermissionReply,
      onQuestionReply: handleQuestionReply,
      onQuestionReject: handleQuestionReject,
    },
    sheets: {
      aiSheetRef,
      queueSheetRef,
      agents: screen.agents,
      selectedAgent: screen.agent,
      providers: screen.providers,
      selectedModel: screen.model,
      variants: screen.currentModelVariants,
      selectedVariant: screen.variant,
      isDark,
      onSelectAgent: screen.setAgent,
      onSelectModel: (providerID, modelID) => screen.setModel({ providerID, modelID }),
      onSelectVariant: screen.setVariant,
      queueItems,
      onRemoveQueued: handleRemoveQueued,
      onUpdateQueued: handleUpdateQueued,
    },
  }
}
