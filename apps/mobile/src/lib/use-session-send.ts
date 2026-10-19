import { Alert } from "react-native"
import type { TFunction } from "i18next"
import type { Attachment } from "@web2bizz/ui-native"
import type { Client } from "./sdk"
import type { ListedSession } from "./listed-session"
import type { ServerCommand } from "./slash-state"
import type { QueuedDraft } from "@/stores/sessions"

export interface SessionSendParams {
  input: string
  attachments: Attachment[]
  setAttachments: (v: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void
  clearComposer: () => void
  setInput: (v: string | ((prev: string) => string)) => void
  serverCommands: ServerCommand[]
  sessionClient: Client | null
  currentSession: ListedSession | null
  agent: string
  model: { providerID: string; modelID: string } | null
  variant: string | null
  isSending: boolean
  enqueueMessage: (
    sessionID: string,
    text: string,
    opts?: Pick<QueuedDraft, "files" | "model" | "agent" | "variant">,
  ) => QueuedDraft
  sendMessage: (
    text: string,
    model?: { providerID: string; modelID: string },
    agent?: string,
    files?: Array<{ uri: string; mime: string; filename?: string; base64?: string }>,
    variant?: string,
  ) => Promise<void>
  authenticateForMessage: () => Promise<boolean>
  t: TFunction
}

// Отправка: auth → server slash commands → outbox (пока busy) → send
// с восстановлением драфта при ошибке. Поведение 1:1 с инлайн-версией.
export function useSessionSend(params: SessionSendParams): () => Promise<void> {
  const {
    input,
    attachments,
    setAttachments,
    clearComposer,
    setInput,
    serverCommands,
    sessionClient,
    currentSession,
    agent,
    model,
    variant,
    isSending,
    enqueueMessage,
    sendMessage,
    authenticateForMessage,
    t,
  } = params

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

  return handleSend
}
