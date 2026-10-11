/**
 * @web2bizz/ui-native — shared UI kit: the single home for every reusable
 * visual component and the pure UI-support utils behind it. App-bound
 * components (stores, server clients, app release checks) live in
 * `src/components/` instead — never duplicated here.
 */

export * from "./theme"
export * from "./Container"
export * from "./hooks/use-tablet"
export { LanDiscoveryModal } from "./components/LanDiscoveryModal"
// Chat sheets and bubbles (props-driven; the kit never imports app stores).
export { Select, type SelectOption } from "./components/chat/Select"
export { SheetHandle } from "./components/chat/SheetHandle"
export { PickerSheet } from "./components/chat/PickerSheet"
export { AiSettingsModal } from "./components/chat/AiSettingsModal"
export { DirectorySwitcher } from "./components/chat/DirectorySwitcher"
export { DirectoryBrowserSheet } from "./components/chat/DirectoryBrowserSheet"
export { MessageBubble } from "./components/chat/MessageBubble"
export { ToolCallCard } from "./components/chat/ToolCallCard"
export { DiffView } from "./components/chat/DiffView"
export { ReasoningBlock } from "./components/chat/ReasoningBlock"
export { PermissionPrompt } from "./components/chat/PermissionPrompt"
export { QuestionPrompt } from "./components/chat/QuestionPrompt"
export { StatusIndicator, type StatusSnapshot } from "./components/chat/StatusIndicator"
export { SlashPopover, type SlashCommand } from "./components/chat/SlashPopover"
export { ImageAttachments, type Attachment } from "./components/chat/ImageAttachments"
export { SessionInfo } from "./components/chat/SessionInfo"
export { MessageQueueSheet, type QueuedItem } from "./components/chat/MessageQueueSheet"
export { CopyLink } from "./components/markdown/CopyLink"
export { Markdown } from "./components/markdown/Markdown"
export { CodeBlock } from "./components/markdown/CodeBlock"
// Pure UI-support utils (unit-tested, no app imports).
export { isLandscapeSize, shouldCapSheetContent, sheetContentCap } from "./utils/sheet-layout"
export { parentOf, nameOf, breadcrumbsOf, stripTrailingSlash } from "./utils/path-utils"
export { extractGitHubUrls } from "./utils/github-links"
export { composerMaxHeight, keyboardVerticalOffset, COMPOSER_MIN_HEIGHT } from "./utils/session-layout"
export type { LanCandidate } from "./utils/lan-discover"
export type {
  Message,
  Part,
  Session,
  Provider,
  ProviderModel,
  FileEntry,
  FileRoot,
  DirectoryClient,
} from "./types"
