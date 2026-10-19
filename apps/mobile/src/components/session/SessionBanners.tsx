import { View, Text, TouchableOpacity } from "react-native"
import type { TFunction } from "i18next"
import { s } from "@app/session/styles"

export interface SessionBannersProps {
  reconnectAttempts: number
  showConnectedFlash: boolean
  revertMessageID: string | undefined
  onUndoRevert: () => void
  t: TFunction
}

// Баннеры сессии: SSE reconnect/connected + pending revert (из "Edit message").
export function SessionBanners({
  reconnectAttempts,
  showConnectedFlash,
  revertMessageID,
  onUndoRevert,
  t,
}: SessionBannersProps) {
  return (
    <>
      {/* SSE reconnect/connected banner */}
      {reconnectAttempts > 0 && (
        <View style={[s.banner, s.bannerReconnecting]}>
          <Text style={s.bannerText}>{t("session.banners.reconnecting", { attempt: reconnectAttempts })}</Text>
        </View>
      )}
      {showConnectedFlash && reconnectAttempts === 0 && (
        <View style={[s.banner, s.bannerConnected]}>
          <Text style={s.bannerText}>{t("session.banners.connected")}</Text>
        </View>
      )}

      {/* Pending revert (from "Edit message") — offer a way back before it's
          cleaned up by the next prompt. */}
      {revertMessageID && (
        <View style={[s.banner, s.bannerRevert]}>
          <Text style={s.bannerText}>{t("session.banners.reverted")}</Text>
          <TouchableOpacity onPress={onUndoRevert} hitSlop={8}>
            <Text style={s.bannerAction}>{t("session.banners.undo")}</Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  )
}
