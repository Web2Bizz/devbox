// ui/screens/projects/ProjectsScreen — TUI project picker (presentational, no fs).
// Option rows reuse the home marker style (`›` follows the selection,
// plain `1. name` rows otherwise) without the block-art header.
// Arrows move `selected`; Enter confirms; digits 1-9 select directly
// when the list fits (<=9); Esc/q cancels with null.
// Transparency: fg-only, every row width 100%.
import { useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";

export type ProjectsScreenProps = {
  projects: string[];
  initialSelected?: number;
  onSelect: (index: number | null, name: string | null) => void;
  onCancel?: () => void;
};

/** Home-style option row: only the `›` marker differs, no art offset. */
function projectOptionLine(name: string, selected: boolean, position: number): string {
  const marker = selected ? "› " : "  ";
  return `${marker}${position + 1}. ${name}`;
}

export function ProjectsScreen({ projects, initialSelected, onSelect, onCancel }: ProjectsScreenProps) {
  const [selected, setSelected] = useState(() => {
    if (projects.length === 0) return 0;
    return Math.min(Math.max(0, initialSelected ?? 0), projects.length - 1);
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const cancel = (): void => {
    if (onCancel) onCancel();
    else onSelect(null, null);
  };
  const confirm = (index: number): void => {
    const name = projects[index];
    if (name === undefined) return;
    onSelect(index, name);
  };
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") {
      cancel();
      return;
    }
    if (projects.length === 0) return;
    if (key.name === "up") {
      setSelected((current) => (current - 1 + projects.length) % projects.length);
      return;
    }
    if (key.name === "down") {
      setSelected((current) => (current + 1) % projects.length);
      return;
    }
    if (key.name === "return" || key.name === "linefeed" || key.name === "enter") {
      confirm(selectedRef.current);
      return;
    }
    if (key.name !== undefined && /^[1-9]$/.test(key.name) && projects.length <= 9) {
      confirm(Number(key.name) - 1);
    }
  });
  return (
    <box flexDirection="column" justifyContent="center" alignItems="stretch" width="100%" height="100%">
      <text width="100%">{"проекты — выбери из списка"}</text>
      <text width="100%">{" "}</text>
      {projects.map((name, i) => (
        <text key={name} width="100%">
          {projectOptionLine(name, i === selected, i)}
        </text>
      ))}
      <text width="100%">{" "}</text>
      <text width="100%">{"↑↓ + Enter · или 1-9 · Esc — назад"}</text>
    </box>
  );
}
