import { View } from "react-native"
import type BottomSheet from "@gorhom/bottom-sheet"
import {
  AiSettingsModal,
  MessageQueueSheet,
  type QueuedItem,
} from "@web2bizz/ui-native"
import type { Agent } from "@/utils/sdk"
import type { Provider } from "@/utils/catalog-parse"
import { s } from "@app/session/styles"

export type SessionSheetsProps = {
  aiSheetRef: React.RefObject<BottomSheet | null>
  queueSheetRef: React.RefObject<BottomSheet | null>
  agents: Agent[]
  selectedAgent: string
  providers: Provider[]
  selectedModel: { providerID: string; modelID: string } | null
  variants: Record<string, { reasoningEffort?: string }> | undefined
  selectedVariant: string | null
  isDark: boolean
  onSelectAgent: (name: string) => void
  onSelectModel: (providerID: string, modelID: string) => void
  onSelectVariant: (variant: string | null) => void
  queueItems: QueuedItem[]
  onRemoveQueued: (id: string) => void
  onUpdateQueued: (id: string, text: string) => void
}

// AI settings dialog (agent + model + reasoning effort) + outbox sheet.
// Layer wrapper: gorhom renders inline (not a portal), so without an
// explicit stacking level the composer overlay buttons (zIndex: 1) and
// the scroll-to-bottom button (Android elevation 4) bleed through the
// open sheet and its backdrop. box-none keeps list touches working
// while the sheet is closed (index -1).
export function SessionSheets({
  aiSheetRef,
  queueSheetRef,
  agents,
  selectedAgent,
  providers,
  selectedModel,
  variants,
  selectedVariant,
  isDark,
  onSelectAgent,
  onSelectModel,
  onSelectVariant,
  queueItems,
  onRemoveQueued,
  onUpdateQueued,
}: SessionSheetsProps) {
  return (
    <View style={s.sheetLayer} pointerEvents="box-none">
      <AiSettingsModal
        sheetRef={aiSheetRef}
        agents={agents}
        selectedAgent={selectedAgent}
        providers={providers}
        selectedModel={selectedModel}
        variants={variants}
        selectedVariant={selectedVariant}
        isDark={isDark}
        onSelectAgent={onSelectAgent}
        onSelectModel={onSelectModel}
        onSelectVariant={onSelectVariant}
      />
      <MessageQueueSheet
        sheetRef={queueSheetRef}
        items={queueItems}
        isDark={isDark}
        onRemove={onRemoveQueued}
        onUpdate={onUpdateQueued}
        testID="message-queue-sheet"
      />
    </View>
  )
}
