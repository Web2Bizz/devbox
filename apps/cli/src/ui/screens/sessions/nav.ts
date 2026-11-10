// ui/screens/sessions/nav — keyboard nav for the sessions picker.
// Pure: move + digit parse, no React, no I/O.
export function moveSessionsSelection(current: number, dir: "up" | "down", total: number): number {
  if (total <= 0) return 0;
  const next = dir === "up" ? current - 1 : current + 1;
  return ((next % total) + total) % total;
}

export function parseSessionsDigit(name: string | undefined, total: number): number | null {
  if (name === undefined || total > 9) return null;
  if (!/^[1-9]$/.test(name)) return null;
  const index = Number(name) - 1;
  return index >= 0 && index < total ? index : null;
}
