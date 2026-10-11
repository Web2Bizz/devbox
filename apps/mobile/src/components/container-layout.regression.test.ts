import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// Tablet-adaptive layout regression coverage.
//
// What changed and why (single adaptive pass + card 2/5 uikit move):
//   - packages/uikit/src/theme.ts (re-exported via src/lib/theme.ts shim):
//     breakpoints { tablet: 768, desktop: 1024 } + layout
//     { contentMaxWidth: 640, formMaxWidth: 500, modalMaxWidth: 560 }.
//   - packages/uikit/src/Container.tsx (re-exported via
//     src/components/Container.tsx shim): optional maxWidth prop (centered via
//     alignSelf) — the old docstring forbade maxWidth for "mobile 100%".
//   - packages/uikit/src/hooks/use-tablet.ts (re-exported via
//     src/lib/use-tablet.ts shim): useWindowDimensions().width -> numColumns
//     (1 / 2 / 3). Must NOT use Dimensions.get (static snapshot, see
//     MessageBubble.tsx:179).
//   - app/login.tsx: form wrapped in centered maxWidth-500 View.
//   - app/(tabs)/index.tsx: FlatList numColumns from the hook + key +
//     columnWrapperStyle gap, projectCard flex: 1, wide content centered.
//   - app/(tabs)/account.tsx: root View -> ScrollView with centered
//     maxWidth-640 content (settings.tsx pattern).
//
// Like wide-content-scroll.regression.test.ts, this repo's runtime is React
// Native, so components can't be rendered with node:test. These tests read
// the actual source and assert on the markers that would prove a regression.

function readSource(relativePath: string): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return readFileSync(path.join(dir, relativePath), "utf8")
}

// Card 2/5 (uikit decompose): theme / Container / use-tablet live in
// packages/uikit/src — this helper reads the package sources.
function readPackageSource(relativePath: string): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return readFileSync(path.join(dir, "../../packages/uikit/src", relativePath), "utf8")
}

test("theme exposes tablet breakpoints and max-width layout tokens", () => {
  const src = readPackageSource("theme.ts")
  assert.match(src, /tablet:\s*768/, "breakpoints.tablet must be 768")
  assert.match(src, /desktop:\s*1024/, "breakpoints.desktop must be 1024")
  assert.match(src, /contentMaxWidth:\s*640/, "layout.contentMaxWidth must be 640")
  assert.match(src, /formMaxWidth:\s*500/, "layout.formMaxWidth must be 500")
  assert.match(src, /modalMaxWidth:\s*560/, "layout.modalMaxWidth must be 560")
  assert.match(src, /export type Breakpoints/, "Breakpoints type must be exported")
})

test("Container accepts an optional centered maxWidth", () => {
  const src = readPackageSource("Container.tsx")
  assert.match(src, /maxWidth\?:\s*number/, "Container must accept maxWidth?: number")
  assert.match(src, /alignSelf:\s*"center"/, "maxWidth container must center via alignSelf")
  assert.doesNotMatch(src, /Не навязывает maxWidth/, "old maxWidth ban docstring must be gone")
})

test("use-tablet derives columns from live window width, not Dimensions.get", () => {
  const src = readPackageSource("hooks/use-tablet.ts")
  assert.match(src, /useWindowDimensions/, "must use useWindowDimensions (rotation-reactive)")
  assert.match(src, /breakpoints\.desktop/, "3-col threshold must source breakpoints.desktop")
  assert.match(src, /breakpoints\.tablet/, "2-col threshold must source breakpoints.tablet")
  assert.doesNotMatch(src, /Dimensions\.get/, "must not use static Dimensions.get snapshot")
})

test("no legacy re-export shims remain (single implementation in the kit)", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  // Every reusable component/util has exactly one implementation in
  // packages/uikit/src — these src/ paths must stay deleted (app-bound
  // exceptions with real code here: AuthGate, CloneRepoSheet,
  // ConnectionBadge, UpdateBanner, ErrorBoundary).
  for (const shim of [
    "../lib/theme.ts",
    "../lib/use-tablet.ts",
    "Container.tsx",
    "LanDiscoveryModal.tsx",
    "chat/index.ts",
    "chat/AiSettingsModal.tsx",
    "chat/DiffView.tsx",
    "chat/diff-compute.ts",
    "chat/DirectoryBrowserSheet.tsx",
    "chat/DirectorySwitcher.tsx",
    "chat/ImageAttachments.tsx",
    "chat/MessageBubble.tsx",
    "chat/PermissionPrompt.tsx",
    "chat/PickerSheet.tsx",
    "chat/QuestionPrompt.tsx",
    "chat/ReasoningBlock.tsx",
    "chat/Select.tsx",
    "chat/SessionInfo.tsx",
    "chat/SheetHandle.tsx",
    "chat/SlashPopover.tsx",
    "chat/StatusIndicator.tsx",
    "chat/ToolCallCard.tsx",
    "markdown/index.tsx",
    "markdown/CodeBlock.tsx",
    "markdown/CopyLink.tsx",
    "markdown/Markdown.tsx",
  ]) {
    assert.ok(!existsSync(path.join(dir, shim)), `${shim} must be gone — import from @web2bizz/ui-native instead`)
  }
})

test("login form is wrapped in a centered max-width container", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../app/login.tsx"),
    "utf8",
  )
  assert.match(src, /maxWidth:\s*500/, "login form wrapper must cap width at 500")
  assert.match(src, /testID="login-auth-error"/, "auth error text needs a Maestro testID")
})

test("projects list renders an adaptive numColumns grid", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../app/(tabs)/index.tsx"),
    "utf8",
  )
  assert.match(src, /numColumns=\{numColumns\}/, "FlatList must take numColumns from useTablet()")
  assert.match(src, /key=\{numColumns\}/, "FlatList must re-mount on column-count change")
  assert.match(src, /columnWrapperStyle/, "multi-column rows need a gap wrapper style")
  assert.match(src, /testID="project-list"/, "grid needs a Maestro testID")
  assert.match(src, /projectCard:\s*\{[^}]*flex:\s*1/s, "projectCard must flex to share row width")
})

test("account screen scrolls inside a centered max-width container", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../app/(tabs)/account.tsx"),
    "utf8",
  )
  assert.match(src, /<ScrollView/, "account root must be a ScrollView (was a bare View)")
  assert.match(src, /layout\.contentMaxWidth/, "account content must source layout.contentMaxWidth")
  assert.match(src, /testID="account-login-button"/, "not-logged-in button needs a Maestro testID")
})
