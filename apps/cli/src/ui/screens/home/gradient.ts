// ui/home/gradient — logo gradient (fg-only truecolor, no bg codes).
// Two render paths share one column→color mapping:
//  - stdout (gradientTitle): ANSI 38;2 fg-only.
//  - OpenTUI (homeArtSegments): per-chunk hex fg (no ANSI in content).
import { ANSI_FG_CLOSE } from "../../shared/chat.js";
import { HOME_TITLE_ART, HOME_TITLE_STOPS, type HomeRgb } from "./constants.js";
import { homeArtBlock, widthOf } from "./layout.js";

const ESC = String.fromCharCode(27);

/** Parse #RRGGBB (or short #RGB) into 0-255 channels. */
export function hexToRgb(hex: string): HomeRgb {
  const body = hex.replace("#", "");
  const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Format 0-255 channels as uppercase #RRGGBB (OpenTUI ColorInput-compatible). */
export function rgbToHex({ r, g, b }: HomeRgb): string {
  const pad = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${pad(r)}${pad(g)}${pad(b)}`.toUpperCase();
}

/**
 * Piecewise-linear interpolation across hex stops, t in [0,1] clamped.
 * t=0 → first stop, t=1 → last stop.
 */
export function gradientColorAt(stops: readonly string[], t: number): HomeRgb {
  const clamped = Math.min(1, Math.max(0, t));
  const segs = Math.max(1, stops.length - 1);
  const pos = clamped * segs;
  const i = Math.min(segs - 1, Math.floor(pos));
  const f = pos - i;
  const a = hexToRgb(stops[i] ?? "#FFFFFF");
  const b = hexToRgb(stops[i + 1] ?? "#FFFFFF");
  return {
    r: Math.round(a.r + (b.r - a.r) * f),
    g: Math.round(a.g + (b.g - a.g) * f),
    b: Math.round(a.b + (b.b - a.b) * f),
  };
}

/** ANSI truecolor fg open (ESC built via fromCharCode — repo ASCII rule). */
export function ansiFgTruecolor({ r, g, b }: HomeRgb): string {
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/**
 * Horizontal logo gradient across the whole block-art title (fg-only
 * truecolor, no bg codes). The column→color mapping is shared by every row
 * (t = col / (blockWidth - 1), blockWidth = widest visible line), so color
 * stripes align vertically row-to-row. Spaces stay uncolored (fg on a space
 * is invisible) — stripAnsi() restores every line 1-в-1.
 */
export function gradientTitle(
  lines: readonly string[],
  stops: readonly string[] = HOME_TITLE_STOPS,
): string[] {
  const block = Math.max(1, ...lines.map((line) => widthOf(line)));
  const denom = Math.max(1, block - 1);
  return lines.map((line) =>
    [...line]
      .map((ch, col) =>
        ch === " " ? ch : `${ansiFgTruecolor(gradientColorAt(stops, col / denom))}${ch}${ANSI_FG_CLOSE}`,
      )
      .join(""),
  );
}

export type HomeArtSegment = { text: string; fg?: string };

/**
 * OpenTUI-native gradient: <text> carries a single fg per node, so
 * each padded art row is split into plain chunks with an interpolated hex
 * fg. Chunk colors reuse the gradientTitle column mapping (same stops, same
 * t at chunk center), so the TUI stripes match the stdout ANSI gradient.
 * Leading centering pad stays a single uncolored chunk (no fg → default).
 * Empty art rows yield one blank chunk (mirrors the " " content fallback).
 */
export function homeArtSegments(
  width = 80,
  chunkCols = 6,
  stops: readonly string[] = HOME_TITLE_STOPS,
): HomeArtSegment[][] {
  const block = homeArtBlock(width).lines;
  const artWidth = Math.max(1, ...[...HOME_TITLE_ART].map((line) => [...line].length));
  const denom = Math.max(1, artWidth - 1);
  const size = Math.max(1, Math.floor(chunkCols) || 6);
  return block.map((line) => {
    if (line === "") return [{ text: " " }];
    const padMatch = /^ */.exec(line);
    const padLen = padMatch ? padMatch[0].length : 0;
    const segments: HomeArtSegment[] = [];
    if (padLen > 0) segments.push({ text: line.slice(0, padLen) });
    const art = line.slice(padLen);
    const chars = [...art];
    for (let start = 0; start < chars.length; start += size) {
      const piece = chars.slice(start, start + size);
      const center = start + (piece.length - 1) / 2;
      segments.push({ text: piece.join(""), fg: rgbToHex(gradientColorAt(stops, center / denom)) });
    }
    return segments;
  });
}
