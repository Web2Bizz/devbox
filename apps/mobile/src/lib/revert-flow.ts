import { useCallback } from "react"
import { Alert } from "react-native"
import type { TFunction } from "i18next"
import type { RevertResult } from "@/queries/session-ops"

export interface RevertFlowDeps {
  t: TFunction
  revertMutation: { mutateAsync: (id: string) => Promise<RevertResult> }
  setInput: (v: string) => void
  setAttachments: (v: any) => void
  clearComposer: () => void
  inputRef: { current: string }
}

export function useRevertFlow(deps: RevertFlowDeps) {
  const { t, revertMutation, setInput, setAttachments, clearComposer, inputRef } = deps

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
      setAttachments(
        result.files
          .filter((f): f is typeof f & { url: string; mime: string } => !!f.url && !!f.mime)
          .map((f) => ({ uri: f.url, mime: f.mime, filename: f.filename })),
      )
    },
    [t, setInput, setAttachments],
  )

  const handleMessageLongPress = useCallback(
    (messageID: string) => {
      Alert.alert(t("session.alerts.messageActionsTitle"), undefined, [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("session.actions.editMessage"),
          onPress: () => {
            const doRevert = async () => {
              const result = await revertMutation.mutateAsync(messageID)
              applyRevertResult(result)
            }
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
    },
    [applyRevertResult, revertMutation, t, inputRef],
  )

  return { applyRevertResult, handleMessageLongPress }
}
