// ui/screens/repl/ReplScreen — declarative OpenTUI REPL tree.
// Sticky-bottom history + prompt input pinned last (space-between).
// Transparency: fg props only, every row width 100%.
// Native kinds: header/box/error/table render as plain <text>, no ASCII art, no frames.
import { useEffect, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { titleTextOptions } from "../home/index.js";
import { Spinner } from "../../components/index.js";
import type { LineStore, ReplLine } from "../../shared/store.js";

export type ReplAppProps = {
  store: LineStore;
  maxLength: number;
  onSubmitLine: (raw: string) => void;
  onWidth: (width: number) => void;
};

function padCell(cell: string, width: number): string {
  const len = [...cell].length;
  return len >= width ? cell : cell + " ".repeat(width - len);
}

function parseTable(text: string): { headers: string[]; rows: string[][] } | null {
  try {
    const data = JSON.parse(text) as { headers?: unknown; rows?: unknown };
    if (!Array.isArray(data.headers) || !Array.isArray(data.rows)) return null;
    if (!data.headers.every((h) => typeof h === "string")) return null;
    if (!data.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string"))) return null;
    return { headers: data.headers as string[], rows: data.rows as string[][] };
  } catch {
    return null;
  }
}

function MessageRow({ line, verbatimWidth }: { line: ReplLine; verbatimWidth: "100%" }) {
  if (line.kind === "title") {
    return (
      <text key={line.id} width={verbatimWidth} wrapMode="none" truncate={false}>
        {line.text}
      </text>
    );
  }
  if (line.kind === "header") {
    return (
      <text key={line.id} fg={line.fg ?? "yellow"} width="100%">
        {line.text === "" ? " " : line.text}
      </text>
    );
  }
  if (line.kind === "box") {
    return (
      <box key={line.id} flexDirection="column" width="100%">
        {line.text.split("\n").map((row, i) => (
          <text key={i} width="100%">
            {row === "" ? " " : row}
          </text>
        ))}
      </box>
    );
  }
  if (line.kind === "error") {
    const parts = line.text.split("\n");
    const message = parts[0] ?? " ";
    const hints = parts.slice(1);
    return (
      <box key={line.id} width="100%" flexDirection="column">
        <text fg="red">{"\u2717 " + (message === "" ? " " : message)}</text>
        {hints.map((hint, i) => (
          <text key={i} fg="red">
            {"  \u2192 " + (hint === "" ? " " : hint)}
          </text>
        ))}
      </box>
    );
  }
  if (line.kind === "table") {
    const parsed = parseTable(line.text);
    if (!parsed) {
      return (
        <text key={line.id} width="100%" {...(line.fg ? { fg: line.fg } : {})}>
          {line.text}
        </text>
      );
    }
    const colCount = parsed.headers.length;
    const widths = parsed.headers.map((h, i) => {
      let max = [...h].length;
      for (const row of parsed.rows) max = Math.max(max, [...(row[i] ?? "")].length);
      return max;
    });
    const renderRow = (cells: string[], rowKey: number) => (
      <box key={rowKey} flexDirection="row" width="100%">
        {cells.map((cell, i) => (
          <text key={i}>{i < colCount - 1 ? padCell(cell ?? "", widths[i] ?? 4) + "  " : padCell(cell ?? "", widths[i] ?? 4)}</text>
        ))}
      </box>
    );
    return (
      <box key={line.id} flexDirection="column" width="100%">
        {renderRow(parsed.headers, -1)}
        {parsed.rows.map((row, i) => renderRow(row, i))}
      </box>
    );
  }
  if (line.kind === "spinner") return <Spinner key={line.id} label={line.text} />;
  return (
    <text key={line.id} width="100%" {...(line.fg ? { fg: line.fg } : {})}>
      {line.text}
    </text>
  );
}

/** REPL tree: sticky-bottom history + prompt input pinned last (space-between). */
export function ReplApp({ store, maxLength, onSubmitLine, onWidth }: ReplAppProps) {
  const [lines, setLines] = useState<ReplLine[]>(() => store.snapshot());
  const [value, setValue] = useState("");
  const { width } = useTerminalDimensions();
  const verbatim = titleTextOptions();
  const verbatimWidth = verbatim.width as "100%";
  useEffect(() => store.subscribe(setLines), [store]);
  useEffect(() => {
    onWidth(width);
  }, [width, onWidth]);
  const handleSubmit = (raw: any): void => {
    const s = typeof raw === "string" ? raw : String(raw ?? "");
    setValue("");
    onSubmitLine(s);
  };
  return (
    <box flexDirection="column" justifyContent="space-between" alignItems="stretch" width="100%" height="100%">
      <scrollbox flexGrow={1} width="100%" stickyScroll stickyStart="bottom">
        {lines.map((line) => (
          <MessageRow key={line.id} line={line} verbatimWidth={verbatimWidth} />
        ))}
      </scrollbox>
      <input
        placeholder="prompt > "
        maxLength={maxLength}
        focused
        value={value}
        onInput={(v: any) => setValue(typeof v === "string" ? v : String(v ?? ""))}
        onSubmit={handleSubmit}
      />
    </box>
  );
}
