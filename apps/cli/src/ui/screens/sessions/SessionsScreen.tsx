// ui/screens/sessions/SessionsScreen — TUI sessions picker.
// Mirrors ProjectsScreen: marker ›, arrows/digits/Enter/Esc.
// Presentational: rows come from props (data-layer lives in core/),
// origin badge is plain text. fg-only, width 100%, no border.
import { useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { listSessionLines } from "../../../core/queries/sessions/index.js";
import type { SessionInfo } from "../../../core/queries/sessions/index.js";
import { moveSessionsSelection, parseSessionsDigit } from "./nav.js";

export type SessionsScreenProps = {
  sessions: SessionInfo[];
  initialSelected?: number;
  onSelect: (index: number | null, session: SessionInfo | null) => void;
  onCancel?: () => void;
};

export function SessionsScreen({ sessions, initialSelected, onSelect, onCancel }: SessionsScreenProps) {
  const [selected, setSelected] = useState(() => {
    if (sessions.length === 0) return 0;
    return Math.min(Math.max(0, initialSelected ?? 0), sessions.length - 1);
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const cancel = (): void => {
    if (onCancel) onCancel();
    else onSelect(null, null);
  };
  const confirm = (index: number): void => {
    const session = sessions[index];
    if (!session) return;
    onSelect(index, session);
  };
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") {
      cancel();
      return;
    }
    if (sessions.length === 0) return;
    if (key.name === "up") {
      setSelected((current) => moveSessionsSelection(current, "up", sessions.length));
      return;
    }
    if (key.name === "down") {
      setSelected((current) => moveSessionsSelection(current, "down", sessions.length));
      return;
    }
    if (key.name === "return" || key.name === "linefeed" || key.name === "enter") {
      confirm(selectedRef.current);
      return;
    }
    const digit = parseSessionsDigit(key.name, sessions.length);
    if (digit !== null) confirm(digit);
  });
  const lines = listSessionLines(sessions, selected);
  return (
    <box flexDirection="column" justifyContent="center" alignItems="stretch" width="100%" height="100%">
      <text width="100%">{"сессии — выбери из списка"}</text>
      <text width="100%">{" "}</text>
      {sessions.length === 0 ? (
        <text width="100%">{"нет сессий — создай первую из чата"}</text>
      ) : (
        lines.map((line, i) => (
          <text key={sessions[i]?.id ?? i} width="100%">
            {line}
          </text>
        ))
      )}
      <text width="100%">{" "}</text>
      <text width="100%">{"↑↓ + Enter · или 1-9 · Esc — назад"}</text>
    </box>
  );
}
