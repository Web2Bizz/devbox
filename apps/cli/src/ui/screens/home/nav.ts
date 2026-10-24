// ui/home/nav — home keyboard navigation.
import {
  HOME_OPTIONS,
  HOME_SELECT_DOWN,
  HOME_SELECT_UP,
  type HomeInput,
  type HomeOptionIndex,
} from "./constants.js";

/** Move selection with wrap-around (arrow navigation). */
export function moveHomeSelection(current: number, dir: "up" | "down"): HomeOptionIndex {
  const n = HOME_OPTIONS.length;
  const next = dir === "up" ? current - 1 : current + 1;
  return (((next % n) + n) % n) as HomeOptionIndex;
}

/**
 * Parse one fallback line (digits 1-3) or a raw arrow escape.
 * "1"/"2"/"3" (also exact option text, case-insensitive trim) →
 * select; ESC[A / ESC[B → move; empty → invalid (caller re-prompts).
 */
// Retained + tested pure contract (no production callers in TUI-only flows).
export function parseHomeInput(raw: string): HomeInput {
  const line = raw.trim().toLowerCase();
  if (line === "1" || line === HOME_OPTIONS[0].toLowerCase()) return { kind: "select", index: 0 };
  if (line === "2" || line === HOME_OPTIONS[1].toLowerCase()) return { kind: "select", index: 1 };
  if (line === "3" || line === HOME_OPTIONS[2].toLowerCase()) return { kind: "select", index: 2 };
  if (raw === HOME_SELECT_UP || line === "up" || line === "к") return { kind: "move", dir: "up" };
  if (raw === HOME_SELECT_DOWN || line === "down") return { kind: "move", dir: "down" };
  return { kind: "invalid" };
}
