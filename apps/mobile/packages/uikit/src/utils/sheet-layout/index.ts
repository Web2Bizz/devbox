// Shared tablet/landscape geometry for bottom sheets.
//
// Two problems on wide screens (tablet landscape in particular):
// 1. %-of-height detents collapse: "40%" of an 800pt-tall landscape screen
//    is a 320pt strip — the sheet opens but is unusable. Landscape needs a
//    near-full-height detent.
// 2. Full-bleed content: rows/controls stretched across 1100+pt are
//    unreadable. Sheet content gets a centered max-width column instead
//    (the sheet itself stays full-bleed so the backdrop still covers all).
//
// Pure — unit-testable under node --test. Call sites read dimensions via
// useWindowDimensions and apply these helpers.
//
// NOTE: deliberately no theme import here — utils stay dependency-free so
// they remain unit-testable under node --test. TABLET_WIDTH mirrors
// breakpoints.tablet — keep in sync with packages/uikit/src/theme.ts.

/** Screen width from which sheet content is capped (== breakpoints.tablet). */
const TABLET_WIDTH = 768

/** Centered content column width inside sheets on wide screens. Matches the
 *  settings/account content column (layout.contentMaxWidth). */
export const SHEET_CONTENT_MAX_WIDTH = 640

/** Landscape = width strictly greater than height. Square counts as portrait
 *  (keeps the compact detents on foldables mid-pose). */
export function isLandscapeSize(width: number, height: number): boolean {
  return width > height
}

/** Cap sheet content once the screen reaches tablet width (portrait tablets
 *  benefit too — an 820pt-wide sheet body is just as stretchy). */
export function shouldCapSheetContent(width: number): boolean {
  return width >= TABLET_WIDTH
}

/** Centered max-width column for sheet bodies: spread into the style array
 *  of title rows and contentContainerStyles of sheet lists. */
export const sheetContentCap = {
  width: "100%",
  maxWidth: SHEET_CONTENT_MAX_WIDTH,
  alignSelf: "center",
} as const
