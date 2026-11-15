import { useRef, useEffect } from "react"

export function useReconnectFlash(reconnectAttempts: number, setShowConnectedFlash: (v: boolean) => void) {
  const prevReconnecting = useRef(false)
  useEffect(() => {
    const isReconnecting = reconnectAttempts > 0
    if (prevReconnecting.current && !isReconnecting) {
      setShowConnectedFlash(true)
      const t = setTimeout(() => setShowConnectedFlash(false), 2000)
      return () => clearTimeout(t)
    }
    prevReconnecting.current = isReconnecting
  }, [reconnectAttempts, setShowConnectedFlash])
}
