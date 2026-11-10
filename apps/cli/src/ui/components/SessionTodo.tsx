// ui/components/SessionTodo — plain todo panel for the session page.
// Pure reducer (add/toggle/remove) + presentational list.
// fg-only, width 100%, no border, no ASCII frames.
import type { ReactNode } from "react";

export type TodoItem = { id: number; text: string; done: boolean };

export type TodoAction =
  | { kind: "add"; text: string }
  | { kind: "toggle"; id: number }
  | { kind: "remove"; id: number };

export function todoReducer(items: TodoItem[], action: TodoAction, nextId: number): { items: TodoItem[]; nextId: number } {
  if (action.kind === "add") {
    const clean = action.text.trim();
    if (!clean) return { items, nextId };
    return { items: [...items, { id: nextId, text: clean, done: false }], nextId: nextId + 1 };
  }
  if (action.kind === "toggle") {
    return { items: items.map((item) => (item.id === action.id ? { ...item, done: !item.done } : item)), nextId };
  }
  return { items: items.filter((item) => item.id !== action.id), nextId };
}

export function todoLine(item: TodoItem): string {
  return `${item.done ? "x" : " "} ${item.text}`;
}

export function SessionTodoPanel({ items }: { items: TodoItem[] }): ReactNode {
  return (
    <box flexDirection="column" width="100%">
      <text width="100%">{"задачи сессии"}</text>
      {items.length === 0 ? (
        <text width="100%">{"пусто — /todo <текст>"}</text>
      ) : (
        items.map((item) => (
          <text key={item.id} width="100%">
            {todoLine(item)}
          </text>
        ))
      )}
    </box>
  );
}
