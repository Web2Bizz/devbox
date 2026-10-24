// ui/shared/store — outside-React history for <ReplApp/>.
// Capped line list with a subscribe hook; no rendering here.
// TUI renders natively via screens/ReplScreen.tsx (kind → <box>/<text>).
export type ReplKind = "plain" | "user" | "agent" | "title" | "box" | "error" | "header" | "table" | "spinner";

export type ReplLine = { id: number; kind: ReplKind; text: string; fg?: string; title?: boolean };

export type LinePushOpts = { fg?: string; title?: boolean; kind?: ReplKind };

export type LineStore = {
  snapshot: () => ReplLine[];
  subscribe: (fn: (lines: ReplLine[]) => void) => () => void;
  push: (text: string, opts?: LinePushOpts) => void;
  /** @deprecated legacy, use pushOwned — kept for compat, do not extend. */
  pushSingle: (text: string) => number;
  pushOwned: (text: string, opts?: LinePushOpts) => number;
  /** @deprecated legacy, use pushOwned — kept for compat, do not extend. */
  update: (id: number, text: string) => void;
  remove: (id: number) => void;
};

/** Outside-React history: capped line list with a subscribe hook for <ReplApp/>. */
export function createLineStore(cap: number): LineStore {
  let nextId = 1;
  let lines: ReplLine[] = [];
  const listeners = new Set<(lines: ReplLine[]) => void>();
  const emit = (): void => {
    const snap = [...lines];
    for (const fn of listeners) fn(snap);
  };
  const trim = (): void => {
    while (lines.length > cap) lines.shift();
  };
  const resolveKind = (opts?: LinePushOpts): ReplKind => {
    if (opts?.kind) return opts.kind;
    if (opts?.title) return "title";
    return "plain";
  };
  const isStructural = (kind: ReplKind): boolean =>
    kind === "box" || kind === "error" || kind === "header" || kind === "table";
  return {
    snapshot: () => [...lines],
    subscribe: (fn) => {
      listeners.add(fn);
      fn([...lines]);
      return () => {
        listeners.delete(fn);
      };
    },
    push: (text, opts) => {
      const kind = resolveKind(opts);
      // Structural kinds stay a single entry (native <box> owns layout);
      // plain/user/agent/title keep legacy per-line split for compat.
      if (isStructural(kind)) {
        const body = text === "" ? " " : text;
        lines.push({ id: nextId++, kind, text: body, fg: opts?.fg, ...(kind === "title" ? { title: true } : {}) });
        trim();
        emit();
        return;
      }
      for (const raw of text.split("\n")) {
        lines.push({
          id: nextId++,
          kind,
          text: raw === "" ? " " : raw,
          fg: opts?.fg,
          ...((kind === "title" || opts?.title) ? { title: true } : {}),
        });
      }
      trim();
      emit();
    },
    /** @deprecated legacy, use pushOwned — kept for compat, do not extend. */
    pushSingle: (text) => {
      const id = nextId++;
      lines.push({ id, kind: "plain", text });
      trim();
      emit();
      return id;
    },
    pushOwned: (text, opts) => {
      const kind = resolveKind(opts);
      const id = nextId++;
      lines.push({
        id,
        kind,
        text,
        fg: opts?.fg,
        ...((kind === "title" || opts?.title) ? { title: true } : {}),
      });
      trim();
      emit();
      return id;
    },
    /** @deprecated legacy, use pushOwned — kept for compat, do not extend. */
    update: (id, text) => {
      const line = lines.find((l) => l.id === id);
      if (line) {
        line.text = text;
        emit();
      }
    },
    remove: (id) => {
      const at = lines.findIndex((l) => l.id === id);
      if (at >= 0) {
        lines.splice(at, 1);
        emit();
      }
    },
  };
}
