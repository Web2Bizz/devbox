// ui/screens/sessions-grid/SessionsGridScreen — 2D sessions grid.
// Cells show title + originBadge plain text. Enter opens, x/d closes,
// Esc goes back. Mutations go through caller callbacks (QueryClient
// invalidate lives in runners/interactive, not here).
// fg-only, width 100%, no border.
import { useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { gridCells } from "../../../core/queries/sessions/index.js";
import type { SessionInfo } from "../../../core/queries/sessions/index.js";
import { moveGridSelection } from "./nav.js";

export type SessionsGridScreenProps = {
  sessions: SessionInfo[];
  columns?: number;
  initialSelected?: number;
  onOpen: (session: SessionInfo) => void;
  onCloseSession: (session: SessionInfo) => void;
  onBack: () => void;
};

function gridLine(title: string, badge: string, selected: boolean): string {
  const marker = selected ? "› " : "  ";
  return `${marker}${title} [${badge}]`;
}

export function SessionsGridScreen({
  sessions,
  columns,
  initialSelected,
  onOpen,
  onCloseSession,
  onBack,
}: SessionsGridScreenProps) {
  const cols = columns ?? 2;
  const [selected, setSelected] = useState(() => {
    if (sessions.length === 0) return 0;
    return Math.min(Math.max(0, initialSelected ?? 0), sessions.length - 1);
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") {
      onBack();
      return;
    }
    if (sessions.length === 0) return;
    if (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right") {
      const dir = key.name;
      setSelected((current) => moveGridSelection(current, dir, sessions.length, cols));
      return;
    }
    if (key.name === "return" || key.name === "linefeed" || key.name === "enter") {
      const session = sessions[selectedRef.current];
      if (session) onOpen(session);
      return;
    }
    if (key.name === "x" || key.name === "d") {
      const session = sessions[selectedRef.current];
      if (session) onCloseSession(session);
    }
  });
  const rows = gridCells(sessions, cols);
  return (
    <box flexDirection="column" justifyContent="center" alignItems="stretch" width="100%" height="100%">
      <text width="100%">{"сессии — сетка"}</text>
      <text width="100%">{" "}</text>
      {sessions.length === 0 ? (
        <text width="100%">{"нет сессий — создай первую из чата"}</text>
      ) : (
        rows.map((cells, r) => (
          <box key={r} flexDirection="row" width="100%">
            {cells.map((cell) => {
              const flat = sessions.findIndex((s) => s.id === cell.id);
              return (
                <text key={cell.id} width="100%">
                  {gridLine(cell.title, cell.badge, flat === selected)}
                </text>
              );
            })}
          </box>
        ))
      )}
      <text width="100%">{" "}</text>
      <text width="100%">{"стрелки · Enter открыть · x/d закрыть · Esc назад"}</text>
    </box>
  );
}
