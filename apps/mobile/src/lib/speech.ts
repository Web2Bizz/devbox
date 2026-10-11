import { useState, useCallback, useRef, useEffect } from "react"
import * as Localization from "expo-localization"

// expo-speech-recognition requires a dev build (native module not in Expo Go).
// Make it optional so `npx expo start` in Expo Go doesn't crash at import time.
let ExpoSpeechRecognitionModule: any
let useSpeechRecognitionEvent: any
let nativeAvailable = true
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("expo-speech-recognition") as typeof import("expo-speech-recognition")
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent
} catch {
  nativeAvailable = false
  ExpoSpeechRecognitionModule = {
    requestPermissionsAsync: async () => ({ granted: false }),
    start: () => {},
    stop: () => {},
    abort: () => {},
  }
  useSpeechRecognitionEvent = () => {}
}

/** Recognition language from the device locale (e.g. "ru-RU"), en-US fallback. */
function recognitionLang(): string {
  try {
    return Localization.getLocales()[0]?.languageTag || "en-US"
  } catch {
    return "en-US"
  }
}

interface SpeechState {
  listening: boolean
  transcript: string
  error: string | null
}

interface SpeechActions {
  start: () => Promise<void>
  stop: () => void
  cancel: () => void
}

export function useSpeech(onResult: (text: string) => void): SpeechState & SpeechActions {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [error, setError] = useState<string | null>(null)
  const pending = useRef("")

  useSpeechRecognitionEvent("start", () => {
    setListening(true)
    setError(null)
    setTranscript("")
    pending.current = ""
  })

  useSpeechRecognitionEvent("end", () => {
    setListening(false)
    // Deliver final transcript
    if (pending.current.trim()) {
      onResult(pending.current.trim())
    }
    setTranscript("")
    pending.current = ""
  })

  useSpeechRecognitionEvent("result", (event: any) => {
    const text = event.results[0]?.transcript || ""
    pending.current = text
    setTranscript(text)
  })

  useSpeechRecognitionEvent("error", (event: any) => {
    // "no-speech" is not really an error — user just didn't say anything.
    // "aborted" is never an error either: the native module emits it every
    // time abort() is called (even when idle), and abort() is only ever
    // invoked intentionally (cancel, unmount cleanup).
    if (event.error === "no-speech" || event.error === "aborted") {
      setListening(false)
      return
    }
    // Keep the native error code visible (e.g. "not-allowed", "service-not-allowed",
    // "network", "busy", "language-not-supported") — the UI surfaces it so a
    // "Voice input failed" alert is actually diagnosable.
    const detail = event.message ? `${event.error}: ${event.message}` : String(event.error)
    setError(detail)
    setListening(false)
  })

  const start = useCallback(async () => {
    if (!nativeAvailable) {
      setError("speech recognition unavailable in Expo Go — use a dev build")
      return
    }
    const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
    if (!result.granted) {
      setError("Microphone permission denied")
      return
    }
    try {
      ExpoSpeechRecognitionModule.start({
        lang: recognitionLang(),
        interimResults: true,
        continuous: true,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop()
  }, [])

  const cancel = useCallback(() => {
    pending.current = ""
    ExpoSpeechRecognitionModule.abort()
    setListening(false)
    setTranscript("")
  }, [])

  // Stop the native recognition session when the screen unmounts — otherwise
  // the mic stays hot in the background. abort() is a no-op when not listening.
  useEffect(() => {
    return () => {
      ExpoSpeechRecognitionModule.abort()
    }
  }, [])

  return { listening, transcript, error, start, stop, cancel }
}
