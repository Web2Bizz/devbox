import type { ReactNode } from "react"
import { View, Text, TextInput, TouchableOpacity, ScrollView } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { LinearGradient } from "expo-linear-gradient"
import type { TFunction } from "i18next"
import {
  SlashPopover,
  ImageAttachments,
  colors,
  type Attachment,
  type SlashCommand,
} from "@web2bizz/ui-native"
import { MAX_COMPOSER_LENGTH } from "@/lib/composer"
import { s } from "@app/session/styles"
import { SUGGESTIONS } from "./EmptyState"

export interface ComposerDockProps {
  isDark: boolean
  keyboardH: number
  bottomInset: number
  onDockLayout: (height: number) => void
  attachments: Attachment[]
  onRemoveAttachment: (index: number) => void
  queueCount: number
  onOpenQueue: () => void
  showFollowUps: boolean
  onSuggestion: (promptKey: string) => void
  slashActive: boolean
  slashQuery: string
  slashCommands: SlashCommand[]
  onSlashSelect: (cmd: SlashCommand) => void
  composerFieldHeight: number
  fieldRef: React.RefObject<TextInput | null>
  input: string
  onChangeText: (text: string) => void
  clearedRef: React.MutableRefObject<boolean>
  inputRef: React.MutableRefObject<string>
  onMeasureHeight: (height: number | null) => void
  speechListening: boolean
  speechTranscript: string
  onMicStart: () => void
  onMicStop: () => void
  isSending: boolean
  onPickLibrary: () => void
  onPickCamera: () => void
  onOpenAiSheet: () => void
  aiSummary: string
  onAbort: () => void
  onSend: () => void
  promptOverlay?: ReactNode
  t: TFunction
}

// Нижний док: квик-действия + ввод (+ аттачменты, когда видны) —
// fixed overlay поверх чата. Высота замеряется (onLayout) и уходит
// в отступ списка, клавиатура поднимает док через bottom.
// Промпты (permission/question) — absolute-оверлей поверх дока (prop promptOverlay).
export function ComposerDock({
  isDark,
  keyboardH,
  bottomInset,
  onDockLayout,
  attachments,
  onRemoveAttachment,
  queueCount,
  onOpenQueue,
  showFollowUps,
  onSuggestion,
  slashActive,
  slashQuery,
  slashCommands,
  onSlashSelect,
  composerFieldHeight,
  fieldRef,
  input,
  onChangeText,
  clearedRef,
  inputRef,
  onMeasureHeight,
  speechListening,
  speechTranscript,
  onMicStart,
  onMicStop,
  isSending,
  onPickLibrary,
  onPickCamera,
  onOpenAiSheet,
  aiSummary,
  onAbort,
  onSend,
  promptOverlay,
  t,
}: ComposerDockProps) {
  return (
    <View
      style={[s.dock, isDark && s.dockDark, { bottom: keyboardH, paddingBottom: Math.max(12, bottomInset) }]}
      onLayout={(e) => onDockLayout(e.nativeEvent.layout.height)}
    >
      {/* Затемнение под доком: полупрозрачный градиент сверху вниз
          (прозрачный → 55% чёрного в тёмной теме / 90% белого в светлой,
          в цвет фона). Лежит absolute-подложкой: контент дока
          рисуется поверх, тапы сквозь (pointerEvents none), на layout не влияет. */}
      <LinearGradient
        colors={
          isDark
            ? (["rgba(0,0,0,0)", "rgba(0,0,0,0.55)"] as const)
            : (["rgba(255,255,255,0)", "rgba(255,255,255,0.9)"] as const)
        }
        style={s.dockGradient}
        pointerEvents="none"
      />
      {promptOverlay}

      {/* Attachment preview */}
      <ImageAttachments attachments={attachments} isDark={isDark} onRemove={onRemoveAttachment} />

      {/* Outbox: queued follow-ups waiting for idle */}
      {queueCount > 0 && (
        <View style={s.queueBar}>
          <TouchableOpacity
            style={[s.queueBtn, isDark && s.queueBtnDark]}
            onPress={onOpenQueue}
            testID="message-queue-button"
            accessibilityRole="button"
            accessibilityLabel={t("session.queue.button", { count: queueCount })}
          >
            <Ionicons name="time-outline" size={15} color={isDark ? colors.textPlaceholder : colors.neutral.gray600} />
            <Text style={[s.queueBtnText, isDark && s.queueBtnTextDark]}>
              {t("session.queue.button", { count: queueCount })}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Follow-up quick actions (after the agent finishes) */}
      {showFollowUps && (
        <View style={[s.followUpBar, isDark && s.followUpBarDark]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={s.followUpScroll}
            contentContainerStyle={s.followUpContent}
          >
            {SUGGESTIONS.map((item) => (
              <TouchableOpacity
                key={item.key}
                style={[s.followUpChip, isDark && s.followUpChipDark]}
                onPress={() => onSuggestion(item.promptKey)}
                testID={`followup-${item.key}`}
                accessibilityRole="button"
                accessibilityLabel={t(item.labelKey)}
              >
                <Ionicons
                  name={item.icon as keyof typeof Ionicons.glyphMap}
                  size={13}
                  color={isDark ? colors.textPlaceholder : colors.neutral.gray600}
                />
                <Text style={[s.followUpText, isDark && s.followUpTextDark]}>{t(item.labelKey)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Input */}
      <View style={[s.inputContainer, isDark && s.inputContainerDark]}>
        <View style={s.inputRow}>
          {/* Список команд: absolute-оверлей, заходит за поле ввода
              (низ палитры прячется под полем — выходит из-под блока ввода),
              растёт вверх поверх быстрых действий. В замере dockHeight не участвует. */}
          {slashActive && (
            <View style={[s.slashWrap, { paddingBottom: Math.max(0, composerFieldHeight - 16) }]}>
              <SlashPopover query={slashQuery} commands={slashCommands} isDark={isDark} onSelect={onSlashSelect} />
            </View>
          )}
          <TextInput
            ref={fieldRef}
            style={[s.input, isDark && s.inputDark, speechListening && s.inputListening, { height: composerFieldHeight }]}
            placeholder={
              speechListening
                ? t("session.input.placeholderListening")
                : isSending
                  ? t("session.input.placeholderFollowUp")
                  : t("session.input.placeholderDefault")
            }
            placeholderTextColor={speechListening ? "#ef4444" : isDark ? "#666666" : "#999999"}
            value={speechListening ? speechTranscript : input}
            onChangeText={speechListening ? undefined : onChangeText}
            onContentSizeChange={(e) => {
              // Stale-window gate (see clearComposer): a contentSize event
              // landing after a clear while the committed text is still
              // empty is a pre-clear echo — ignore it so it can't resurrect
              // a tall box or poison the floor. Empty then always means the
              // minimum height (the null set below bails out without a
              // render when already null, so this can't loop).
              // Voice transcripts render through `value` while `input` stays
              // empty, so listening mode is exempt — the transcript must
              // keep growing the box.
              if (!speechListening && clearedRef.current && !inputRef.current) {
                onMeasureHeight(null)
                return
              }
              onMeasureHeight(e.nativeEvent.contentSize.height)
            }}
            editable={!speechListening}
            multiline
            scrollEnabled
            maxLength={MAX_COMPOSER_LENGTH}
            testID="chat-message-input"
          />
          {/* Overlay control bar: bottom row over the input.
              box-none lets taps outside the buttons fall through to the field. */}
          <View style={s.overlayBtns} pointerEvents="box-none">
            <View style={s.overlayGroup}>
              {!speechListening && (
                <TouchableOpacity style={s.overlayBtn} onPress={onPickLibrary} onLongPress={onPickCamera}>
                  <Ionicons name="add-circle-outline" size={24} color={isDark ? "#888888" : "#666666"} />
                </TouchableOpacity>
              )}
              {!speechListening && (
                <TouchableOpacity
                  style={s.overlayBtn}
                  onPress={onOpenAiSheet}
                  testID="ai-settings-button"
                  accessibilityLabel={aiSummary}
                >
                  <Ionicons name="options-outline" size={24} color={isDark ? "#888888" : "#666666"} />
                </TouchableOpacity>
              )}
            </View>
            <View style={s.overlayGroup}>
              {!isSending && !input.trim() && attachments.length === 0 && !speechListening && (
                <TouchableOpacity style={s.overlayBtn} onPress={onMicStart} accessibilityLabel={t("session.actions.mic")}>
                  <Ionicons name="mic" size={24} color={isDark ? "#888888" : "#666666"} />
                </TouchableOpacity>
              )}
              {speechListening && (
                <TouchableOpacity style={s.overlayBtn} onPress={onMicStop}>
                  <Ionicons name="mic" size={24} color="#ef4444" />
                </TouchableOpacity>
              )}
              {/* Stop button: only when busy and no input */}
              {isSending && !input.trim() && attachments.length === 0 && !speechListening && (
                <TouchableOpacity style={s.overlayBtn} onPress={onAbort} accessibilityLabel={t("session.actions.stop")}>
                  <Ionicons name="stop" size={24} color="#ef4444" />
                </TouchableOpacity>
              )}
              {/* Send button: when there's input */}
              {!speechListening && (input.trim() || attachments.length > 0) && (
                <TouchableOpacity
                  style={s.overlayBtn}
                  onPress={onSend}
                  testID="chat-send-button"
                  accessibilityLabel={t("session.actions.send")}
                >
                  <Ionicons name="send" size={24} color={isDark ? "#ffffff" : "#0a0a0a"} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </View>
    </View>
  )
}
