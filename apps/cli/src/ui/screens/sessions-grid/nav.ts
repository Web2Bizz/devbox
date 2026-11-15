// ui/screens/sessions-grid/nav — 2D grid navigation.
// Pure: arrows move in row/col space, digits pick linearly.
// No React, no I/O.
export function moveGridSelection(
  current: number,
  dir: "up" | "down" | "left" | "right",
  total: number,
  columns: number,
): number {
  if (total <= 0) return 0;
  const cols = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 1;
  const row = Math.floor(current / cols);
  const col = current % cols;
  const rows = Math.ceil(total / cols);
  if (dir === "left") return (current - 1 + total) % total;
  if (dir === "right") return (current + 1) % total;
  if (dir === "up") {
    const prev = (row - 1 + rows) % rows;
    return Math.min(prev * cols + col, total - 1);
  }
  const next = (row + 1) % rows;
  return Math.min(next * cols + col, total - 1);
}
