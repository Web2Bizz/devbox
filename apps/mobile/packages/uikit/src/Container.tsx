import { View, StyleSheet, type ViewProps } from "react-native"
import { layout } from "./theme"

/**
 * Container — единый горизонтальный контейнер для всего приложения.
 *
 * До этого в проекте Container / Header как отдельные компоненты отсутствовали:
 * - `app/_layout.tsx` и `app/(tabs)/_layout.tsx` используют нативный header
 *   expo-router (Stack / Tabs), без кастомного <Header>
 * - каждый экран задавал `padding: 16` / `paddingHorizontal: 16` вручную
 * - из-за отсутствия container-токена `headerRight` (ConnectionBadge) рендерился
 *   без отступа справа и не выравнивался с контентом
 *
 * Этот компонент фиксирует ширину контейнера через `layout.containerPadding`
 * (16) и используется как:
 *  - обёртка для контента экранов
 *  - источник токена для `headerRightContainerStyle` / `headerLeftContainerStyle`
 *
 * По умолчанию контейнер = 100% ширины с горизонтальными полями.
 * На планшете можно передать `maxWidth` (см. `layout.contentMaxWidth` /
 * `layout.formMaxWidth`) — контейнер центрируется через `alignSelf: "center"`.
 */
export function Container({
  style,
  children,
  maxWidth,
  ...props
}: ViewProps & { maxWidth?: number }) {
  return (
    <View style={[styles.container, maxWidth != null && { maxWidth, alignSelf: "center" as const }, style]} {...props}>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    paddingHorizontal: layout.containerPadding,
  },
})
