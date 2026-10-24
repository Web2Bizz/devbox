// ui/home/screen — stdout home renderers (pure, no I/O).
import { HOME_OPTIONS, HOME_SIGNATURE } from "./constants.js";
import { gradientTitle } from "./gradient.js";
import { centerLines, homeArtBlock } from "./layout.js";

/**
 * Verbatim title block for the plain stdout fallback: block-art as a unit
 * (single left offset, no wrap/trim — inner double spaces kept 1-в-1).
 * Narrow width → left-aligned as-is (right-clip by the terminal, never
 * mid-line wrap). Colored with the logo gradient by default
 * (opt out: { color: false }).
 */
export function formatHomeTitlePlain(width = 80, opts?: { color?: boolean }): string {
  const block = homeArtBlock(width).lines;
  return (opts?.color === false ? block : gradientTitle(block)).join("\n");
}

/**
 * Render the home screen: blank padding above (vertical centering) + centered
 * block-art title as a unit (single left offset, no truncation/wrap;
 * narrow → left-aligned) with the horizontal logo gradient (fg-only truecolor;
 * opt out: { color: false }) + signature right below the art on the same left
 * edge (artLeft) + options below in the same left-aligned block. Selected
 * row gets the "›" marker. Pure function — caller writes via process.stdout
 * (never console.*).
 */
// Retained + tested pure contract (no production callers in TUI-only flows).
export function renderHomeScreen(width = 80, selected: number = 0, opts?: { color?: boolean }): string {
  const safe = Math.max(20, Math.floor(width) || 80);
  const sel = ((selected % HOME_OPTIONS.length) + HOME_OPTIONS.length) % HOME_OPTIONS.length;
  const { lines: artBlock, artLeft } = homeArtBlock(safe);
  const artColored = opts?.color === false ? artBlock : gradientTitle(artBlock);
  const head: string[] = ["", ""];
  const gap: string[] = [""];
  const signatureLine = " ".repeat(artLeft) + HOME_SIGNATURE;
  const optionLines: string[] = HOME_OPTIONS.map((opt, i) => {
    const marker = i === sel ? "› " : "  ";
    return `${" ".repeat(artLeft)}${marker}${i + 1}. ${opt}`;
  });
  const tail: string[] = ["", "↑↓ + Enter · или 1-3"];
  return [
    ...centerLines(head, safe),
    ...artColored,
    signatureLine,
    ...centerLines(gap, safe),
    ...optionLines,
    ...centerLines(tail, safe),
  ].join("\n");
}
