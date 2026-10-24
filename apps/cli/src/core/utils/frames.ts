// core/utils/frames — ASCII spinner frames only (no timers, no I/O).
// Frames: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏. Caller drives timing (REPL or tests).

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(index: number): string {
  const normalized = ((index % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[normalized];
}

export function spinnerLine(index: number, label: string): string {
  return `${spinnerFrame(index)} ${label}`;
}
