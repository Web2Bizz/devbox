// core/utils/paste — paste-safe input normalization (no I/O, no React).
/** Max input length (paste-safe). Upstream <input> defaults to 1000. */
export const TUI_INPUT_MAX_LENGTH = 10000;

const BRACKETED_START = String.fromCharCode(27) + "[200~";
const BRACKETED_END = String.fromCharCode(27) + "[201~";

export function normalizePastedText(raw: string): string {
  const deBracketed = raw.split(BRACKETED_START).join("").split(BRACKETED_END).join("");
  const lf = deBracketed.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const C0 = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", "g");
  const singleLine = lf.split("\n").map((line) => line.replace(C0, "").replace(/\t/g, " ")).join(" ");
  const collapsed = singleLine.replace(/ {2,}/g, " ").trim();
  return [...collapsed].slice(0, TUI_INPUT_MAX_LENGTH).join("");
}
