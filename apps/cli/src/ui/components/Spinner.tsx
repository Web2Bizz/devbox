// ui/components/Spinner — self-animated spinner row (owns its timer).
// Transparency: fg-only, full width, frameless. Animation lives here,
// not in tui/runners session.spin (which only pushes/removes the row).

import { useEffect, useState } from "react";
import { SPINNER_FRAMES, spinnerLine } from "../../core/utils/frames.js";

export function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <text width="100%">{spinnerLine(frame, label)}</text>;
}
