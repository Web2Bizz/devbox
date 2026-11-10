/**
 * Unwraps the Postgres SQLSTATE through drizzle's DrizzleQueryError
 * (real code lives in `.cause`, possibly nested) — without this, unique
 * (23505) / FK (23503) violations would all surface as 503 instead of the
 * intended 409/404. Never logs the value — codes only.
 */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth: number = 0; depth < 4 && current !== null && current !== undefined; depth++) {
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isPgUniqueViolation(error: unknown): boolean {
  if (pgCode(error) === "23505") return true;
  const message: string = error instanceof Error ? error.message : String(error ?? "");
  return /duplicate key|unique/i.test(message);
}

export function isPgForeignKeyViolation(error: unknown): boolean {
  if (pgCode(error) === "23503") return true;
  const message: string = error instanceof Error ? error.message : String(error ?? "");
  return /foreign key|violates foreign/i.test(message);
}
