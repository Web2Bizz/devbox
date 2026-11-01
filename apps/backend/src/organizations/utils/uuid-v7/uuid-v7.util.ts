/**
 * Shape of the Bun runtime global we rely on (Bun ≥ 1.4.2 implements
 * RFC 9562 `Bun.randomUUIDv7(timestamp?)`). tsconfig pins `types: ["node"]`,
 * so the Bun global is declared locally instead of pulling @types/bun.
 */
type BunRuntime = { randomUUIDv7(timestamp?: number | Date): string };

/** The Bun global, resolved at call time (no silent fallback — backend runs on Bun). */
function bunRuntime(): BunRuntime | null {
  const runtime = (globalThis as { Bun?: Partial<BunRuntime> }).Bun;
  return runtime && typeof runtime.randomUUIDv7 === "function"
    ? (runtime as BunRuntime)
    : null;
}

/**
 * RFC 9562 uuidv7 (unix_ts_ms + rand_a/rand_b) — time-ordered invite ids
 * straight from the runtime: `Bun.randomUUIDv7(nowMs)` (no extra dependency,
 * no hand-rolled generator). Throws when the runtime lacks it — the backend
 * runs on Bun, so a Node-only environment is a misconfiguration, not a case
 * to paper over with a fallback.
 */
export function randomUuidV7(nowMs = Date.now()): string {
  const bun = bunRuntime();
  if (!bun) {
    throw new Error(
      "randomUuidV7 requires the Bun runtime (Bun.randomUUIDv7) — the backend must run on Bun",
    );
  }
  return bun.randomUUIDv7(Math.floor(nowMs));
}

/** uuidv7 shape (version 7 + RFC 4122 variant) — non-v7 never matches a row. */
export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
