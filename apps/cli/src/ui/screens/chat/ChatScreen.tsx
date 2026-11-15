// ui/screens/chat/ChatScreen — chat page wrapper over ReplApp.
// Props: sessionId/origin/initialLines; LineStore seeded once.
// Row: left ~30% SessionsSidebar + right (ReplApp + SessionTodoPanel below).
// Hooks only here (data-layer stays in core/). fg-only, width 100%.
import { useMemo, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { TUI_INPUT_MAX_LENGTH, normalizePastedText } from "../../../core/utils/paste.js";
import { createLineStore } from "../../shared/store.js";
import type { SessionInfo, SessionOrigin } from "../../../core/queries/sessions/index.js";
import { originBadge } from "../../../core/queries/sessions/index.js";
import { SessionTodoPanel, todoReducer, type TodoItem } from "../../components/SessionTodo.js";
import { ReplApp } from "../repl/ReplScreen.js";
import { SessionsSidebar } from "./SessionsSidebar.js";

export type ChatScreenProps = {
  sessionId: string;
  origin: SessionOrigin;
  greeting: string;
  initialLines?: string[];
  onLine: (line: string) => Promise<{ exit: boolean; reply?: string }>;
  onExit: () => void;
  sessions?: SessionInfo[];
  onSelectSession?: (session: SessionInfo) => void;
};

export function ChatScreen({ sessionId, origin, greeting, initialLines, onLine, onExit, sessions, onSelectSession }: ChatScreenProps) {
  const store = useMemo(() => {
    const next = createLineStore(400);
    next.push(`${greeting}\n${sessionId} [${originBadge(origin)}]`);
    for (const line of initialLines ?? []) next.push(line);
    return next;
  }, [greeting, sessionId, origin, initialLines]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [nextId, setNextId] = useState(1);
  const { width } = useTerminalDimensions();
  const onWidth = (_next: number): void => {
    void width;
  };
  void onSelectSession;
  const onSubmitLine = (raw: string): void => {
    const line = normalizePastedText(raw);
    if (line.startsWith("/todo ")) {
      const text = line.slice(6);
      const result = todoReducer(todos, { kind: "add", text }, nextId);
      setTodos(result.items);
      setNextId(result.nextId);
      store.push(text.trim() === "" ? "пустая задача — пропустили" : `todo: ${text.trim()}`, { kind: "plain" });
      return;
    }
    if (line === "/todo") {
      store.push("usage: /todo <текст>", { kind: "plain" });
      return;
    }
    void (async () => {
      try {
        store.push(line, { kind: "user", fg: "cyan" });
        const result = await onLine(line);
        if (result.reply) store.push(result.reply, { kind: "agent", fg: "green" });
        if (result.exit) onExit();
      } catch {
        // Focused input survives errors; nothing to redo.
      }
    })();
  };
  return (
    <box flexDirection="row" width="100%" height="100%">
      <box flexDirection="column" width="30%">
        <SessionsSidebar sessions={sessions ?? []} selectedId={sessionId} />
      </box>
      <box flexDirection="column" flexGrow={1} width="70%">
        <box flexDirection="column" flexGrow={1} width="100%">
          <ReplApp store={store} maxLength={TUI_INPUT_MAX_LENGTH} onSubmitLine={onSubmitLine} onWidth={onWidth} />
        </box>
        <SessionTodoPanel items={todos} />
      </box>
    </box>
  );
}
