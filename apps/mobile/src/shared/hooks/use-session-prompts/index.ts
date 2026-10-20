import { Alert } from "react-native"
import type { TFunction } from "i18next"
import type { Client } from "../../utils/sdk"

export type SessionPromptDeps = {
  sessionClient: Client | null
  sessionID: string | undefined
  permissionMutation: {
    mutateAsync: (vars: {
      client: Client
      sessionID: string
      requestID: string
      reply: "once" | "always" | "reject"
    }) => Promise<unknown>
  }
  questionMutation: {
    mutateAsync: (vars: {
      client: Client
      sessionID: string
      requestID: string
      answers: string[][]
    }) => Promise<unknown>
  }
  questionRejectMutation: {
    mutateAsync: (vars: { client: Client; sessionID: string; requestID: string }) => Promise<unknown>
  }
  t: TFunction
}

// Ответы на permission/question промпты: optimistic removal + rollback живут
// внутри мутаций, здесь только вызов + alert при ошибке. Поведение 1:1.
export function useSessionPrompts(deps: SessionPromptDeps) {
  const { sessionClient, sessionID, permissionMutation, questionMutation, questionRejectMutation, t } = deps

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

  return { handlePermissionReply, handleQuestionReply, handleQuestionReject }
}
