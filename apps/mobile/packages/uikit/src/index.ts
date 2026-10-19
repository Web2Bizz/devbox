/**
 * @web2bizz/ui-native — shared UI kit: the single home for every reusable
 * visual component and the pure UI-support utils behind it. App-bound
 * components (stores, server clients, app release checks) live in
 * `src/components/` instead — never duplicated here.
 */

export * from "./theme"
export * from "./components/container"
export * from "./hooks/use-tablet"
export { LanDiscoveryModal } from "./components/lan-discovery-modal"
// Chat sheets and bubbles (props-driven; the kit never imports app stores).
export { Select, type SelectOption } from "./components/chat/select"
export { SheetHandle } from "./components/chat/sheet-handle"
export { PickerSheet } from "./components/chat/picker-sheet"
export { AiSettingsModal } from "./components/chat/ai-settings-modal"
export { DirectorySwitcher } from "./components/chat/directory-switcher"
export { DirectoryBrowserSheet } from "./components/chat/directory-browser-sheet"
export { MessageBubble } from "./components/chat/message-bubble"
export { ToolCallCard } from "./components/chat/tool-call-card"
export { DiffView } from "./components/chat/diff-view"
export { ReasoningBlock } from "./components/chat/reasoning-block"
export { PermissionPrompt } from "./components/chat/permission-prompt"
export { QuestionPrompt } from "./components/chat/question-prompt"
export { StatusIndicator, type StatusSnapshot } from "./components/chat/status-indicator"
export { SlashPopover, type SlashCommand } from "./components/chat/slash-popover"
export { ImageAttachments, type Attachment } from "./components/chat/image-attachments"
export { SessionInfo } from "./components/chat/session-info"
export { MessageQueueSheet, type QueuedItem } from "./components/chat/message-queue-sheet"
export { CopyLink } from "./components/markdown/copy-link"
export { Markdown } from "./components/markdown/markdown"
export { CodeBlock } from "./components/markdown/code-block"
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
