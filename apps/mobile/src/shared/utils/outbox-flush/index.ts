import { useRef, useEffect, useCallback } from "react"
import { Alert } from "react-native"
import type { TFunction } from "i18next"
import type { QueuedDraft } from "@/stores/sessions"
import { useSessions } from "@/stores/sessions"

export type OutboxFlushParams = {
  currentSession: { id: string } | null
  isSending: boolean
  queuedForSession: QueuedDraft[]
  sendMessage: (text: string, model?: any, agent?: any, files?: any, variant?: any) => Promise<any>
  model: any
  agent: string
  variant: any
  t: TFunction
}

export function useOutboxFlush(params: OutboxFlushParams) {
  const { currentSession, isSending, queuedForSession, sendMessage, model, agent, variant, t } = params
  const wasBusyRef = useRef(false)
  const settledHeadRef = useRef<string | null>(null)

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
    const next = head
    // takeNextQueued is handled by caller? We replicate: remove head from queue via store.
    // To keep store in sync, call takeNextQueued through sessions store.
    const drafted = useSessions.getState().takeNextQueued(currentSession.id)
    const toSend = drafted ?? next
    const sessionID = currentSession.id
    sendMessage(toSend.text, toSend.model ?? model ?? undefined, toSend.agent ?? agent ?? undefined, toSend.files, toSend.variant ?? variant ?? undefined).catch((err) => {
      console.error("Queued send failed:", err)
      useSessions.setState((state: any) => ({
        queue: { ...state.queue, [sessionID]: [toSend, ...(state.queue[sessionID] ?? [])] },
      }))
      Alert.alert(t("session.alerts.sendFailedTitle"), t("session.alerts.sendFailedMessage"))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSending, currentSession?.id, queuedForSession, t])

  const resetSettled = useCallback(() => {
    settledHeadRef.current = null
  }, [])

  return { wasBusyRef, settledHeadRef, resetSettled }
}
