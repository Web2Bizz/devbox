// ui/home/constants — RUSH CODE home constants only (no logic, no I/O).
export const HOME_TITLE_ART = [
  "██████  ██    ██ ███████ ██   ██      ██████  ██████  ██████  ███████",
  "██   ██ ██    ██ ██      ██   ██     ██      ██    ██ ██   ██ ██",
  "██████  ██    ██ ███████ ███████     ██      ██    ██ ██   ██ █████",
  "██   ██ ██    ██      ██ ██   ██     ██      ██    ██ ██   ██ ██",
  "██   ██  ██████  ███████ ██   ██      ██████  ██████  ██████  ███████",
];

export const HOME_TITLE = [...HOME_TITLE_ART].join("\n");

export const HOME_OPTIONS = ["Выбрать проект", "Открыть директорию", "Выйти"] as const;

export const HOME_SIGNATURE = "by web2bizz team";

/**
 * Logo gradient stops (eyedropper from the RUSH CODE logo, left → right):
 * orange-yellow → red-orange → pink → purple → blue-cyan.
 */
export const HOME_TITLE_STOPS = ["#FFB02E", "#FF4A2D", "#E93A6B", "#8B3DFF", "#2E9BFF"] as const;

export type HomeRgb = { r: number; g: number; b: number };

export type HomeOptionIndex = 0 | 1 | 2;

export const HOME_SELECT_UP: string = String.fromCharCode(27) + "[A";

export const HOME_SELECT_DOWN: string = String.fromCharCode(27) + "[B";

export type HomeInput =
  | { kind: "select"; index: HomeOptionIndex }
  | { kind: "move"; dir: "up" | "down" }
  | { kind: "invalid" };
