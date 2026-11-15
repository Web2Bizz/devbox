// ui/screens/chat/SessionsSidebar — non-interactive sessions list.
// Rows via listSessionLines (marker › follows selection). fg-only, frameless.
import { listSessionLines, type SessionInfo } from "../../../core/queries/sessions/index.js";

export type SessionsSidebarProps = {
  sessions: SessionInfo[];
  selectedId?: string;
};

export function SessionsSidebar({ sessions, selectedId }: SessionsSidebarProps) {
  const selected = Math.max(
    0,
    selectedId ? sessions.findIndex((s) => s.id === selectedId) : 0,
  );
  const lines = listSessionLines(sessions, selected < 0 ? 0 : selected);
  return (
    <box flexDirection="column" width="100%">
      <text width="100%">{"сессии"}</text>
      <text width="100%">{" "}</text>
      {sessions.length === 0 ? (
        <text width="100%">{"пусто — открой чат"}</text>
      ) : (
        lines.map((line, i) => (
          <text key={sessions[i]?.id ?? i} width="100%">
            {line}
          </text>
        ))
      )}
    </box>
  );
}
