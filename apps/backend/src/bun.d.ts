/**
 * Minimal ambient declaration for the Bun runtime global used by the backend.
 * The service runs on Bun (package.json engines), while tsconfig pins
 * `types: ["node"]`; @types/bun is intentionally not pulled in.
 */
declare const Bun: {
  /** RFC 9562 uuidv7; `timestamp` defaults to now (ms since epoch). */
  randomUUIDv7(timestamp?: number | Date): string;
};
