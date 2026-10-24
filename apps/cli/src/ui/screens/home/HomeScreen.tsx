// ui/screens/home/HomeScreen — OpenTUI home menu (Главная).
// Block-art title rows are static (drawn once from homeArtSegments);
// arrows only move `selected` state, React repaints just the option
// rows (marker `›` follows) — no clear, no art reprint, no flicker.
// Transparency: fg-only, every row width 100%.
import { useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  HOME_OPTIONS,
  centerLines,
  homeArtSegments,
  homeOptionLine,
  homeSignatureLine,
  moveHomeSelection,
  titleTextOptions,
  type HomeOptionIndex,
} from "./index.js";

export type HomeAppProps = {
  initialSelected: HomeOptionIndex;
  onSelect: (index: HomeOptionIndex) => void;
};

/**
 * Home tree (Главная): block-art title rows are static — drawn once from
 * homeArtSegments (one row box per art line, hex fg chunks, no ANSI in
 * content) — then the signature and the 3 options as separate <text> nodes.
 * Arrows only move `selected` state; React repaints just the option rows
 * (marker `›` follows) — no clear, no art reprint, no flicker.
 */
export function HomeApp({ initialSelected, onSelect }: HomeAppProps) {
  const [selected, setSelected] = useState<HomeOptionIndex>(initialSelected);
  const { width: termWidth } = useTerminalDimensions();
  const width = Number.isFinite(termWidth) && termWidth > 0 ? Math.floor(termWidth) : 80;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const verbatim = titleTextOptions();
  const verbatimWidth = verbatim.width as "100%";
  const hint = centerLines(["↑↓ + Enter · или 1-3"], width)[0] ?? "";
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      onSelect(2);
      return;
    }
    if (key.name === "up") {
      setSelected((current) => moveHomeSelection(current, "up"));
      return;
    }
    if (key.name === "down") {
      setSelected((current) => moveHomeSelection(current, "down"));
      return;
    }
    if (key.name === "return" || key.name === "linefeed" || key.name === "enter") {
      onSelect(selectedRef.current);
      return;
    }
    if (key.name === "escape" || key.name === "q") {
      onSelect(2);
      return;
    }
    if (key.name === "1") {
      onSelect(0);
      return;
    }
    if (key.name === "2") {
      onSelect(1);
      return;
    }
    if (key.name === "3") {
      onSelect(2);
    }
  });
  return (
    <box flexDirection="column" justifyContent="center" alignItems="center" width="100%" height="100%">
      {homeArtSegments(width).map((segments, row) => (
        <box key={row} flexDirection="row" width={verbatimWidth}>
          {segments.map((seg, i) =>
            seg.text === "" ? null : (
              <text
                key={i}
                wrapMode={verbatim.wrapMode as "none"}
                truncate={verbatim.truncate}
                {...(seg.fg ? { fg: seg.fg } : {})}
              >
                {seg.text}
              </text>
            ),
          )}
        </box>
      ))}
      <text width="100%">{homeSignatureLine(width)}</text>
      <text width="100%">{" "}</text>
      {HOME_OPTIONS.map((option, i) => (
        <text key={option} width="100%">
          {homeOptionLine(i, selected, width)}
        </text>
      ))}
      <text width="100%">{" "}</text>
      <text width="100%">{hint}</text>
    </box>
  );
}
