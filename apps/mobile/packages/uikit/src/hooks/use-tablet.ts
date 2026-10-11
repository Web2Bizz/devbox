import { useWindowDimensions } from "react-native"
import { breakpoints } from "../theme"

/**
 * use-tablet — планшетный хук для адаптивной сетки.
 *
 * Использует `useWindowDimensions().width` (реактивен к повороту), а не
 * статичный снапшот размера окна (см. MessageBubble.tsx:179 — там размер
 * снимается один раз при старте и не пересчитывается при повороте).
 *
 * Брейкпоинты — единый источник из `../theme` (tablet 768 / desktop 1024),
 * бывшие локальные константы TABLET_BREAKPOINT / DESKTOP_BREAKPOINT убраны.
 */
export function numColumnsForWidth(width: number): 1 | 2 | 3 {
  if (width >= breakpoints.desktop) return 3
  if (width >= breakpoints.tablet) return 2
  return 1
}

export function useTablet() {
  const { width } = useWindowDimensions()
  const isTablet = width >= breakpoints.tablet
  const numColumns = numColumnsForWidth(width)
  return { isTablet, numColumns, width }
}
