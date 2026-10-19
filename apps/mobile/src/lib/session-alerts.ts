import { useEffect } from "react"
import { Alert } from "react-native"
import type { TFunction } from "i18next"

export function useSessionAlerts(speechError: string | null, sessionError: string | null, clearSessionError: () => void, t: TFunction) {
  useEffect(() => {
    if (!speechError) return
    Alert.alert(t("session.alerts.speechErrorTitle"), `${t("session.alerts.speechErrorMessage")}\n\n${speechError}`)
  }, [speechError, t])

  useEffect(() => {
    if (!sessionError) return
    Alert.alert(t("common.error"), sessionError)
    clearSessionError()
  }, [sessionError, clearSessionError, t])
}
