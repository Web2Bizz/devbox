import { useCallback, useEffect, useMemo, useRef } from "react"
import { View, Text, TouchableOpacity, StyleSheet, Keyboard, Platform, useWindowDimensions } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useTranslation } from "react-i18next"
import { colors, breakpoints } from "../../theme"
import { isLandscapeSize, shouldCapSheetContent, sheetContentCap } from "../../utils/sheet-layout"
import { Select, type SelectOption } from "./Select"
import { PickerSheet } from "./PickerSheet"
import { SheetHandle } from "./SheetHandle"

interface AgentItem {
  name: string
  color?: string
  description?: string
}

interface Provider {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

interface Props {
  agents: AgentItem[]
  selectedAgent: string
  providers: Provider[]
  selectedModel: { providerID: string; modelID: string } | null
  variants: Record<string, { reasoningEffort?: string }> | undefined
  selectedVariant: string | null
  isDark: boolean
  onSelectAgent: (name: string) => void
  onSelectModel: (providerID: string, modelID: string) => void
  onSelectVariant: (variant: string | null) => void
  // Parent-owned ref — the sheet is UNCONTROLLED (no `visible` prop): the
  // parent opens/closes it imperatively, exactly like the folder sheets.
  // A controlled `visible` + onChange→close feedback loop proved fragile
  // here (spurious close commands cancel the opening animation), so this
  // deliberately keeps no open/close state of its own.
  sheetRef: React.RefObject<BottomSheet | null>
}

const MODEL_ID_SEP = "/"

// Single AI settings sheet: agent + model open as dedicated picker sheets,
// reasoning effort stays an inline Select (short list). Built on the SAME
// proven recipe as the folder sheets (BottomSheet + index -1 + imperative
// expand/close via parent-owned refs): BottomSheetModal present()/dismiss()
// proved unreliable on this stack (upstream portal and dynamic-sizing
// flakiness in 5.2.x — the sheet silently never opened), and a controlled
// `visible` prop with an onChange→close loop backfires the same way. Model
// selection closes the dialog; agent stays open so several settings can
// change in one go.
export function AiSettingsModal({
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
  sheetRef,
}: Props) {
  const { t } = useTranslation()
  const agentSheetRef = useRef<BottomSheet | null>(null)
  const modelSheetRef = useRef<BottomSheet | null>(null)

  // Picker sheets must open AFTER the keyboard is gone (same recipe as the
  // main sheet open on the session screen): expanding while a field holds
  // focus leaves only the backdrop visible. Dismiss first, expand once
  // keyboardDidHide lands, fallback timer in case the event never comes.
  const pickerPendingRef = useRef(false)
  const pickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pickerKbSubRef = useRef<{ remove: () => void } | null>(null)
  useEffect(
    () => () => {
      if (pickerTimerRef.current) clearTimeout(pickerTimerRef.current)
      pickerTimerRef.current = null
      pickerKbSubRef.current?.remove()
      pickerKbSubRef.current = null
      pickerPendingRef.current = false
    },
    [],
  )
  const expandPicker = useCallback((ref: React.RefObject<BottomSheet | null>) => {
    if (pickerPendingRef.current) return
    pickerPendingRef.current = true
    Keyboard.dismiss()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (pickerTimerRef.current) {
        clearTimeout(pickerTimerRef.current)
        pickerTimerRef.current = null
      }
      pickerKbSubRef.current?.remove()
      pickerKbSubRef.current = null
      pickerPendingRef.current = false
      ref.current?.expand()
    }
    const keyboardVisible = typeof Keyboard.isVisible === "function" ? Keyboard.isVisible() : true
    if (!keyboardVisible) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(finish)
      } else {
        pickerTimerRef.current = setTimeout(finish, 0)
      }
      return
    }
    const sub = Keyboard.addListener("keyboardDidHide", finish)
    pickerKbSubRef.current = sub
    pickerTimerRef.current = setTimeout(finish, Platform.OS === "android" ? 150 : 100)
  }, [])

  // Detents: phones open tall (70%) so the effort list is usable without
  // cramped scrolling; tablets keep the compact 40% portrait sheet.
  // Landscape always goes near-full height — "40%" of a landscape-height
  // screen is a ~300pt strip. Wide content cap: rows must not stretch
  // across a 1100pt+ tablet.
  const { width: winWidth, height: winHeight } = useWindowDimensions()
  const isLandscape = isLandscapeSize(winWidth, winHeight)
  const isPhone = winWidth < breakpoints.tablet
  const capContent = shouldCapSheetContent(winWidth)
  const snapPoints = useMemo(() => {
    if (isLandscape) return ["85%"]
    return [isPhone ? "70%" : "40%"]
  }, [isLandscape, isPhone])
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" opacity={0.5} />
    ),
    [],
  )
  // Picker detents: agents are a handful of rows, models are hundreds.
  const agentSnapPoints = useMemo(() => ["50%"], [])
  const modelSnapPoints = useMemo(() => ["80%"], [])

  const effortDescriptions: Record<string, string> = {
    low: t("chat.variantPicker.effort.low"),
    medium: t("chat.variantPicker.effort.medium"),
    high: t("chat.variantPicker.effort.high"),
  }

  const agentOptions: SelectOption[] = useMemo(
    () =>
      agents.map((a) => ({
        id: a.name,
        label: a.name,
        description: a.description,
        dotColor: a.color || colors.accent,
      })),
    [agents],
  )

  const effortOptions: SelectOption[] = useMemo(
    () => [
      { id: null, label: t("chat.variantPicker.autoLabel"), description: t("chat.variantPicker.autoDescription") },
      ...Object.keys(variants || {}).map((id) => ({
        id: id as string,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        description: effortDescriptions[id],
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variants, t],
  )
  const showEffort = Object.keys(variants || {}).length > 0

  const modelOptions: SelectOption[] = useMemo(() => {
    const list = Array.isArray(providers) ? providers : []
    const out: SelectOption[] = []
    // Selected model first within its provider group
    const ordered = selectedModel
      ? [...list].sort((a, b) => {
          const aHas = a.id === selectedModel.providerID ? 0 : 1
          const bHas = b.id === selectedModel.providerID ? 0 : 1
          return aHas - bHas
        })
      : list
    for (const p of ordered) {
      const models = [...(p.models || [])]
      if (selectedModel && p.id === selectedModel.providerID) {
        models.sort((a, b) => (a.id === selectedModel.modelID ? -1 : b.id === selectedModel.modelID ? 1 : 0))
      }
      for (const m of models) {
        out.push({
          id: `${p.id}${MODEL_ID_SEP}${m.id}`,
          label: m.name || m.id,
          description: p.name || p.id,
          group: p.name || p.id,
        })
      }
    }
    return out
  }, [providers, selectedModel])

  const selectedModelId = selectedModel ? `${selectedModel.providerID}${MODEL_ID_SEP}${selectedModel.modelID}` : null
  const selectedAgentLabel = agentOptions.find((o) => o.id === selectedAgent)?.label ?? selectedAgent ?? "—"
  const selectedModelLabel = modelOptions.find((o) => o.id === selectedModelId)?.label ?? "—"

  const handleSelectModel = useCallback(
    (id: string | null) => {
      if (!id) return
      const sep = id.indexOf(MODEL_ID_SEP)
      onSelectModel(id.slice(0, sep), id.slice(sep + 1))
      // Model selection closes the dialog (agent selection stays open so
      // several settings can change in one go). PickerSheet already
      // dismissed the keyboard (search field); closing the main sheet needs
      // no extra dismiss.
      sheetRef.current?.close()
    },
    [onSelectModel, sheetRef],
  )

  return (
    <>
      <BottomSheet
        ref={sheetRef}
        index={-1}
        snapPoints={snapPoints}
        enableDynamicSizing={false}
        enablePanDownToClose
        // Explicit (true by default): the handle pill must stay draggable.
        enableHandlePanningGesture
        handleComponent={SheetHandle}
        backdropComponent={renderBackdrop}
        backgroundStyle={[s.sheet, isDark && s.sheetDark]}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
      >
        <View style={[s.titleRow, capContent && sheetContentCap]}>
          <Text style={[s.title, isDark && s.textWhite]}>{t("chat.aiSettings.title")}</Text>
        </View>
        <BottomSheetScrollView contentContainerStyle={s.content}>
          <View style={[s.contentInner, capContent && sheetContentCap]}>
            <PickerRow
              label={t("chat.aiSettings.agentLabel")}
              value={selectedAgentLabel}
              isDark={isDark}
              onPress={() => expandPicker(agentSheetRef)}
              testID="agent-select"
            />
            {showEffort && (
              <Select
                label={t("chat.aiSettings.effortLabel")}
                options={effortOptions}
                selectedId={selectedVariant}
                isDark={isDark}
                onSelect={onSelectVariant}
                testID="effort-select"
              />
            )}
            <PickerRow
              label={t("chat.aiSettings.modelLabel")}
              value={selectedModelLabel}
              isDark={isDark}
              onPress={() => expandPicker(modelSheetRef)}
              testID="model-select"
            />
          </View>
        </BottomSheetScrollView>
      </BottomSheet>

      <PickerSheet
        sheetRef={agentSheetRef}
        title={t("chat.agentPicker.title")}
        options={agentOptions}
        selectedId={selectedAgent}
        isDark={isDark}
        onSelect={(id) => id && onSelectAgent(id)}
        snapPoints={agentSnapPoints}
        testID="agent-select"
      />
      <PickerSheet
        sheetRef={modelSheetRef}
        title={t("chat.modelPicker.title")}
        options={modelOptions}
        selectedId={selectedModelId}
        isDark={isDark}
        onSelect={handleSelectModel}
        searchPlaceholder={t("chat.modelPicker.searchPlaceholder")}
        snapPoints={modelSnapPoints}
        testID="model-select"
      />
    </>
  )
}

// Trigger row opening a picker sheet: same box visuals as the Select header
// (label + current value + chevron) so the settings list keeps one rhythm.
function PickerRow({
  label,
  value,
  isDark,
  onPress,
  testID,
}: {
  label: string
  value: string
  isDark: boolean
  onPress: () => void
  testID?: string
}) {
  return (
    <View style={[r.box, isDark && r.boxDark]} testID={testID}>
      <TouchableOpacity style={r.header} onPress={onPress} activeOpacity={0.7}>
        <View style={r.headerText}>
          <Text style={[r.label, isDark && r.metaDark]}>{label}</Text>
          <Text style={[r.value, isDark && r.textWhite]} numberOfLines={1}>
            {value}
          </Text>
        </View>
        <Ionicons
          name="chevron-forward-outline"
          size={18}
          color={isDark ? colors.textSecondaryDark : colors.textSecondaryLight}
        />
      </TouchableOpacity>
    </View>
  )
}

const r = StyleSheet.create({
  box: {
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  // NOTE: #3a3a3a has no theme token (borderDark is #1a1a1a) — kept as-is,
  // mirroring the Select box.
  boxDark: { backgroundColor: colors.surfaceDark2, borderColor: "#3a3a3a" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    gap: 8,
  },
  headerText: { flex: 1, gap: 2 },
  label: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textTertiaryLight,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  value: { fontSize: 15, fontWeight: "600", color: colors.textPrimaryLight },
  textWhite: { color: colors.textPrimaryDark },
  metaDark: { color: colors.textSecondaryDark },
})

const s = StyleSheet.create({
  sheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  sheetDark: { backgroundColor: "#1a1a1a" },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: { fontSize: 18, fontWeight: "700", color: "#0a0a0a" },
  textWhite: { color: "#ffffff" },
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  // Inner column: carries the gap + the wide-screen centered cap (the cap
  // must sit on an inner View — on the scroll content container itself it
  // would left-stick instead of centering).
  contentInner: { gap: 12 },
})
