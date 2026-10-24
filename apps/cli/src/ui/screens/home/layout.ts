// ui/home/layout — home geometry (centering, art block, option rows).
import { stripAnsi } from "../../shared/chat.js";
import { HOME_OPTIONS, HOME_SIGNATURE, HOME_TITLE_ART } from "./constants.js";

/** Visible width: ANSI-aware (strip ESC sequences before measuring). */
export function widthOf(value: string): number {
  return [...stripAnsi(value)].length;
}

/** OpenTUI verbatim options for block-art title: no wrap, no cut (right-clip only). */
export function titleTextOptions(): { wrapMode: string; truncate: boolean; width: string } {
  return { wrapMode: "none", truncate: false, width: "100%" };
}

export function padCenter(line: string, width: number): string {
  const len = widthOf(line);
  if (len >= width) return line;
  const left = Math.floor((width - len) / 2);
  return " ".repeat(left) + line;
}

/** Center every line horizontally (no truncation, no bg; ANSI-aware width). */
export function centerLines(lines: string[], width: number): string[] {
  const safe = Math.max(20, Math.floor(width) || 80);
  return lines.map((line) => padCenter(line, safe));
}

/**
 * Verbatim block-art as a unit: one left offset for all 5 lines keeps columns
 * aligned (per-line centering drifts: 69/64/67 cols → 5 vs 8 pad at width 80).
 * Inner double spaces kept 1-в-1; narrow (artWidth >= width) → left-aligned
 * as-is, right-clip only. Shared by the stdout renderer, the plain helper
 * and the OpenTUI segment splitter so all three match 1-в-1.
 */
export function homeArtBlock(width: number): { lines: string[]; artLeft: number } {
  const safe = Math.max(20, Math.floor(width) || 80);
  const artWidth = Math.max(...[...HOME_TITLE_ART].map((line) => widthOf(line)));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  return { lines: [...HOME_TITLE_ART].map((line) => " ".repeat(artLeft) + line), artLeft };
}

/**
 * Left-aligned home option line on the art left edge (artLeft, same block
 * as art + signature). Only the `›` marker differs between rows — the art
 * block is never part of this string. Narrow terminal (artLeft=0) → col 0.
 * Pure helper for the TUI selector (and its tests).
 */
export function homeOptionLine(index: number, selected: number, width = 80): string {
  const marker = index === selected ? "› " : "  ";
  const raw = `${marker}${index + 1}. ${HOME_OPTIONS[index] ?? ""}`;
  const safe = Math.max(20, Math.floor(width) || 80);
  const artWidth = Math.max(...[...HOME_TITLE_ART].map((line) => [...line].length));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  return " ".repeat(artLeft) + raw;
}

/**
 * Left-aligned home signature line on the same art left edge (artLeft).
 * Drawn once right below the art, never carries the `›` marker.
 */
export function homeSignatureLine(width = 80): string {
  const safe = Math.max(20, Math.floor(width) || 80);
  const artWidth = Math.max(...[...HOME_TITLE_ART].map((line) => [...line].length));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  return " ".repeat(artLeft) + HOME_SIGNATURE;
}

/**
 * Centered block-art title as a unit (single left offset, verbatim
 * double spaces 1-в-1; narrow → left-aligned, right-clip only).
 * Mirrors renderHomeScreen artBlock so the TUI matches the stdout home.
 */
export function homeArtLines(width = 80): string[] {
  const safe = Math.max(20, Math.floor(width) || 80);
  const artWidth = Math.max(...[...HOME_TITLE_ART].map((line) => [...line].length));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  return [...HOME_TITLE_ART].map((line) => " ".repeat(artLeft) + line);
}
