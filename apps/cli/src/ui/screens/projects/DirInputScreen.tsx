// ui/screens/projects/DirInputScreen — TUI custom directory input.
// Presentational: single focused <input> + hint row, no fs.
// Esc cancels; Enter submits the raw value (caller trims + resolves).
// Transparency: fg-only, every row width 100%.
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TUI_INPUT_MAX_LENGTH } from "../../../core/utils/paste.js";

export type DirInputScreenProps = {
  initialValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

export function DirInputScreen({ initialValue, onSubmit, onCancel }: DirInputScreenProps) {
  const [value, setValue] = useState(initialValue ?? "");
  useKeyboard((key) => {
    if (key.name === "escape") onCancel();
  });
  return (
    <box flexDirection="column" justifyContent="center" alignItems="stretch" width="100%" height="100%">
      <input
        placeholder="директория [путь внутри REPOS_ROOT] › "
        maxLength={TUI_INPUT_MAX_LENGTH}
        focused
        value={value}
        onInput={(v: any) => setValue(typeof v === "string" ? v : String(v ?? ""))}
        onSubmit={(v: any) => onSubmit(typeof v === "string" ? v : String(v ?? ""))}
      />
      <text width="100%">{" "}</text>
      <text width="100%">{"путь внутри REPOS_ROOT · .. запрещён · Enter — выбрать · Esc — назад"}</text>
    </box>
  );
}
