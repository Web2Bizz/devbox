/**
 * Unwraps the Postgres SQLSTATE through drizzle's DrizzleQueryError
 * (real code lives in `.cause`, possibly nested) — without this, unique
 * (23505) / FK (23503) violations would all surface as 503 instead of the
 * intended 409/404. Never logs the value — codes only.
 */
function pgCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur !== null && cur !== undefined; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isPgUniqueViolation(err: unknown): boolean {
  if (pgCode(err) === "23505") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /duplicate key|unique/i.test(msg);
}

export function isPgForeignKeyViolation(err: unknown): boolean {
  if (pgCode(err) === "23503") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /foreign key|violates foreign/i.test(msg);
}
