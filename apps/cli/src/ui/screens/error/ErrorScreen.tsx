// ui/screens/error/ErrorScreen — TUI error frame (chat/open flows only).
// Presentational: message + optional hint, no fs, no stdio.
// Enter/Esc closes (caller returns null → back home).
// Transparency: fg-only, every row width 100%.
import { useKeyboard } from "@opentui/react";

export type ErrorScreenProps = {
  message: string;
  hint?: string;
  onClose: () => void;
};

export function ErrorScreen({ message, hint, onClose }: ErrorScreenProps) {
  useKeyboard((key) => {
    if (key.name === "return" || key.name === "linefeed" || key.name === "enter" || key.name === "escape" || key.name === "q") {
      onClose();
    }
  });
  const messageLines = message.split("\n");
  const hintLines = hint === undefined ? [] : hint.split("\n");
  return (
    <box flexDirection="column" justifyContent="center" alignItems="center" width="100%" height="100%">
      <box flexDirection="column" width="100%" alignItems="stretch">
        <text fg="red">{"\u2715 " + (messageLines[0] ?? " ")}</text>
        {messageLines.slice(1).map((line, i) => (
          <text key={`message-${i}`} fg="red">
            {"  " + line}
          </text>
        ))}
        {hintLines.map((line, i) => (
          <text key={`hint-${i}`} fg="red">
            {(i === 0 ? "\u2192 " : "  ") + line}
          </text>
        ))}
        <text width="100%">{" "}</text>
        <text width="100%">{"Enter / Esc — назад"}</text>
      </box>
    </box>
  );
}
