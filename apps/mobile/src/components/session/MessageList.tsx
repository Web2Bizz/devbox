import { useCallback, useEffect, useRef, useState } from "react"
import { View, Text, FlatList, TouchableOpacity, Pressable, ActivityIndicator } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { MessageBubble, StatusIndicator, type StatusSnapshot } from "@web2bizz/ui-native"
import type { Message, Part } from "@/lib/sdk"
import { s } from "@app/session/styles"
import { EmptyState } from "./EmptyState"

export interface MessageListItem {
  message: Message
  parts: Part[]
}

export interface MessageListProps {
  messageData: MessageListItem[]
  status: StatusSnapshot | undefined
  statusText: string | undefined
  optimisticSending: boolean
  isDark: boolean
  hasMore: boolean
  loadingMore: boolean
  dockHeight: number
  slashActive: boolean
  showStatus: boolean
  listRef: React.RefObject<FlatList | null>
  onLongPress: (messageID: string) => void
  onSuggestion: (promptKey: string) => void
  onCloseSlash: () => void
  onLoadMore: () => void
}

// Инвертированный список сообщений + статус + empty state + кнопка скролла +
// подложка палитры команд. Скролл-логика (кнопка, debounce догрузки,
// авто-скролл за статусом) живёт здесь, рядом со списком.
export function MessageList({
  messageData,
  status,
  statusText,
  optimisticSending,
  isDark,
  hasMore,
  loadingMore,
  dockHeight,
  slashActive,
  showStatus,
  listRef,
  onLongPress,
  onSuggestion,
  onCloseSlash,
  onLoadMore,
}: MessageListProps) {
  const { t } = useTranslation()
  const [showScrollButton, setShowScrollButton] = useState(false)

  const scrollToBottom = useCallback(
    (animated = true) => {
      listRef.current?.scrollToOffset({ offset: 0, animated })
    },
    [listRef],
  )

  // Auto-scroll when status appears at bottom of messages (fixed in list)
  useEffect(() => {
    if (status && status.type !== "idle") {
      scrollToBottom(true)
    }
  }, [status, statusText])

  // In inverted mode, offset 0 = bottom. Show scroll button when scrolled away from bottom.
  const handleScroll = useCallback((event: any) => {
    const { contentOffset } = event.nativeEvent
    setShowScrollButton(contentOffset.y > 200)
  }, [])

  // Debounce: onEndReached can fire multiple times during a single scroll gesture
  const loadingTriggered = useRef(false)
  const handleLoadMore = useCallback(() => {
    if (hasMore && !loadingMore && !loadingTriggered.current) {
      loadingTriggered.current = true
      onLoadMore()
    }
  }, [hasMore, loadingMore, onLoadMore])

  // Reset trigger when loading finishes
  useEffect(() => {
    if (!loadingMore) loadingTriggered.current = false
  }, [loadingMore])

  return (
    <View style={s.listWrap}>
      <FlatList
        ref={listRef}
        data={messageData}
        inverted
        keyExtractor={(item) => item.message.id}
        renderItem={({ item }) => (
          <MessageBubble message={item.message} parts={item.parts} isDark={isDark} onLongPress={onLongPress} />
        )}
        // Список инвертирован: верх контентных координат = визуальный низ,
        // поэтому запас под док даём через paddingTop.
        contentContainerStyle={[s.messageList, { paddingTop: 16 + dockHeight }]}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        // Prevent jump when older messages are prepended
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        ListHeaderComponent={
          showStatus ? (
            <StatusIndicator status={status} statusText={statusText} optimistic={optimisticSending} isDark={isDark} />
          ) : null
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={s.loadingMore}>
              <ActivityIndicator size="small" color={isDark ? "#888888" : "#666666"} />
              <Text style={[s.loadingMoreText, isDark && s.metaDark]}>{t("session.loadingOlder")}</Text>
            </View>
          ) : null
        }
      />
      {/* Empty state rendered OUTSIDE the inverted list to avoid the
          inverted transform mirroring its text/icon (see #ui-mirror).
          box-none: taps pass through the overlay itself, chips stay tappable. */}
      {messageData.length === 0 && <EmptyState isDark={isDark} onSuggestion={onSuggestion} />}
      {showScrollButton && (
        <TouchableOpacity
          style={[s.scrollBtn, isDark && s.scrollBtnDark, { bottom: 16 + dockHeight }]}
          onPress={() => scrollToBottom(true)}
        >
          <Ionicons name="chevron-down" size={24} color={isDark ? "#ffffff" : "#0a0a0a"} />
        </TouchableOpacity>
      )}
      {/* Подложка палитры команд: пока палитра открыта, перехватывает
          все тапы/скроллы мимо неё — иначе скроллится список сообщений
          под палитрой. Тап закрывает палитру (текст цел), палитра в доке
          рисуется выше (zIndex дока 2), скролл внутри неё работает. */}
      {slashActive && (
        <Pressable
          style={s.slashBackdrop}
          onPress={onCloseSlash}
          testID="slash-backdrop"
          accessibilityRole="button"
          accessibilityLabel={t("session.actions.closeCommands")}
        />
      )}
    </View>
  )
}
