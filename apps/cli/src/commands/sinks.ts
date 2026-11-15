// commands/sinks — output sinks (stdout + TUI) + structural emit helpers.
import { errorText, headerText, tableText } from "../ui/shared/plain.js";
import {
  formatAgentMessage,
  formatAgentPlain,
  formatUserMessage,
  formatUserPlain,
  terminalWidth,
} from "../ui/shared/chat.js";
import { spinnerLine } from "../core/utils/frames.js";
import type { TuiSession } from "./session.js";

export function out(text: string): void {
  process.stdout.write(text + "\n");
}

/** Output sink: stdout REPL writes directly, TUI REPL appends to history. */
export type LineSink = {
  emit: (text: string) => void;
  /** User prompt echo (cyan fg, plain wrap, full terminal width, no boxes). */
  user: (text: string) => void;
  /** Agent reply (green fg, plain wrap, full terminal width, no boxes). */
  agent: (text: string) => void;
  /** Animated in TUI; a static one-shot line on stdout. Returns a stop fn. */
  spin: (label: string) => () => void;
  /** Structural header (stdout: plain line; TUI: native row). */
  header?: (title: string) => void;
  /** Structural box (stdout: plain lines; TUI: plain text). */
  box?: (lines: string[]) => void;
  /** Structural error (stdout: plain ✗/→ lines; TUI: plain red text). */
  error?: (message: string, hint?: string) => void;
  /** Structural table (stdout: plain rows; TUI: native rows). */
  table?: (headers: string[], rows: string[][]) => void;
};

export const stdoutSink: LineSink = {
  emit: out,
  user: (text: string) => out(formatUserMessage(text, terminalWidth())),
  agent: (text: string) => out(formatAgentMessage(text, terminalWidth())),
  spin: (label: string) => {
    out(spinnerLine(0, label));
    return () => {};
  },
  header: (title: string) => out(headerText(title)),
  box: (lines: string[]) => out(lines.join("\n")),
  error: (message: string, hint?: string) => out(errorText(message, hint)),
  table: (headers: string[], rows: string[][]) => out(tableText(headers, rows)),
};

export function emitHeader(sink: LineSink, title: string): void {
  if (sink.header) sink.header(title);
  else sink.emit(headerText(title));
}

export function emitBox(sink: LineSink, lines: string[]): void {
  if (sink.box) sink.box(lines);
  else sink.emit(lines.join("\n"));
}

export function emitError(sink: LineSink, message: string, hint?: string): void {
  if (sink.error) sink.error(message, hint);
  else sink.emit(errorText(message, hint));
}

export function emitTable(sink: LineSink, headers: string[], rows: string[][]): void {
  if (sink.table) sink.table(headers, rows);
  else sink.emit(tableText(headers, rows));
}

export function tuiSink(session: TuiSession): LineSink {
  return {
    emit: (text: string) => session.print(text),
    // TUI colors via <text> fg (no ANSI in content); width from renderer.
    user: (text: string) => session.printUser(formatUserPlain(text, session.width())),
    agent: (text: string) => session.printAgent(formatAgentPlain(text, session.width())),
    spin: (label: string) => session.spin(label),
    header: (title: string) => session.header(title),
    box: (lines: string[]) => session.box(lines),
    error: (message: string, hint?: string) => session.error(message, hint),
    table: (headers: string[], rows: string[][]) => session.table(headers, rows),
  };
}
