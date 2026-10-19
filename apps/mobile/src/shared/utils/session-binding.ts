import { useFocusEffect } from "expo-router"
import { useCallback } from "react"
import { useConnections } from "@/stores/connections"
import { useSessions } from "@/stores/sessions"
import { refreshPending } from "@/stores/events"

export function useSessionBinding(id: string | undefined, directory: string | undefined, connectionId: string | undefined) {
  useFocusEffect(
    useCallback(() => {
      if (!id) return
      const { selectSession } = useSessions.getState()
      selectSession(id, directory, connectionId).then(() => {
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
}
