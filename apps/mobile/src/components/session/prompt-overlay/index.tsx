import { View, useWindowDimensions } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { PermissionPrompt, QuestionPrompt } from "@web2bizz/ui-native"
import type { PermissionRequest, QuestionRequest } from "@/stores/events"
import { s } from "@app/session/styles"

export type PromptOverlayProps = {
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  isDark: boolean
  onPermissionReply: (requestID: string, reply: "once" | "always" | "reject") => void
  onQuestionReply: (requestID: string, answers: string[][]) => void
  onQuestionReject: (requestID: string) => void
}

// Промпты поверх ввода: absolute-overlay на весь док (zIndex/elevation 5
// выше поля и кнопок) со сплошным фоном в цвет экрана — поле ввода,
// квик-действия и поповеры остаются смонтированы под ним, но не видны
// и недоступны для тапов. После ответа/отклонения оверлей исчезает и
// ввод «возвращается» сам (драфт цел, размонтирования не было).
// Absolute-позиция не участвует в замере dockHeight — список не прыгает.
export function PromptOverlay({
  permissions,
  questions,
  isDark,
  onPermissionReply,
  onQuestionReply,
  onQuestionReject,
}: PromptOverlayProps) {
  const insets = useSafeAreaInsets()
  const { height: windowHeight } = useWindowDimensions()

  return (
    <View
      style={[
        s.promptOverlay,
        isDark && s.promptOverlayDark,
        {
          paddingBottom: Math.max(12, insets.bottom),
          maxHeight: Math.round(windowHeight * 0.6),
        },
      ]}
    >
      {permissions.map((perm) => (
        <PermissionPrompt
          key={perm.id}
          permission={perm}
          isDark={isDark}
          onReply={(reply) => onPermissionReply(perm.id, reply)}
        />
      ))}
      {questions.map((q) => (
        <QuestionPrompt
          key={q.id}
          request={q}
          isDark={isDark}
          onReply={(answers) => onQuestionReply(q.id, answers)}
          onReject={() => onQuestionReject(q.id)}
        />
      ))}
    </View>
  )
}
