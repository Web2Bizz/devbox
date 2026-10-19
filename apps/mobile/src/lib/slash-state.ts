import { useState, useMemo, useCallback } from "react"
import { useRouter } from "expo-router"
import type { SlashCommand } from "@web2bizz/ui-native"

export interface ServerCommand {
  name: string
  description?: string
}

export function useSlashState(
  input: string,
  serverCommands: ServerCommand[],
  clearComposer: () => void,
  openAiSheet: () => void,
  setInput: (v: string) => void,
) {
  const router = useRouter()
  const [slashHidden, setSlashHidden] = useState(false)

  const slashActive = input.startsWith("/") && !input.includes(" ") && !slashHidden
  const slashQuery = slashActive ? input.slice(1) : ""

  const allCommands = useMemo<SlashCommand[]>(() => {
    const custom: SlashCommand[] = serverCommands.map((cmd) => ({
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description ?? "",
      icon: "code-slash-outline",
      type: "custom",
    }))
    const builtin: SlashCommand[] = [
      { trigger: "new", title: "New Session", description: "Start a new session", icon: "add-circle-outline", type: "builtin" },
      { trigger: "model", title: "Switch Model", description: "Choose a different model", icon: "hardware-chip-outline", type: "builtin" },
      { trigger: "agent", title: "Switch Agent", description: "Cycle to next agent", icon: "person-outline", type: "builtin" },
    ]
    return [...custom, ...builtin]
  }, [serverCommands])

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
    [clearComposer, openAiSheet, router, setInput],
  )

  return { slashHidden, setSlashHidden, slashActive, slashQuery, allCommands, handleSlashSelect }
}
