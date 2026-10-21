import { View, useWindowDimensions } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { PermissionPrompt, QuestionPrompt, promptOverlayMaxHeight } from "@web2bizz/ui-native"
import type { PermissionRequest, QuestionRequest } from "@/stores/events"
import { COMPOSER_PADDING, s } from "@app/session/styles"

export type PromptOverlayProps = {
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  isDark: boolean
  onPermissionReply: (requestID: string, reply: "once" | "always" | "reject") => void
  onQuestionReply: (requestID: string, answers: string[][]) => void
  onQuestionReject: (requestID: string) => void
}

// Промпты поверх ввода: absolute-оверлей, прибит к низу дока
// (только bottom: 0, без top — растёт вверх, а не уезжает вниз) с теми
// же инсетами, что и поле ввода (COMPOSER_PADDING со всех сторон,
// safe-area снизу — absolute-оверлей паддинг дока не ловит, поэтому
// дублирует его сам). Высота ужата 70% экрана (promptOverlayMaxHeight),
// переполнение скроллится внутри карточек (список вариантов /
// паттерны), заголовки зафиксированы. zIndex/elevation 5 выше поля и
// кнопок. После ответа/отклонения оверлей исчезает и ввод
// «возвращается» сам (драфт цел, размонтирования не было).
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
          paddingTop: COMPOSER_PADDING,
          paddingHorizontal: COMPOSER_PADDING,
          paddingBottom: Math.max(COMPOSER_PADDING, insets.bottom),
          maxHeight: promptOverlayMaxHeight(windowHeight),
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
