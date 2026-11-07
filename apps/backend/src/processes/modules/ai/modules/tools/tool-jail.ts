import path from 'node:path';
import type { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';

/**
 * Lexical + realpath jail for one tool target. Relative paths only: absolute
 * input, null bytes and `..` escapes answer ForbiddenException (403) — the
 * dispatcher turns that into an error-result the model sees, never a 500.
 */
export async function resolveToolPath(
  paths: WorkspacePathService,
  directory: string,
  relative: string,
): Promise<string> {
  const raw = relative.trim();
  if (raw.length === 0) throw new Error('path is empty');
  if (raw.includes('\0') || path.isAbsolute(raw)) {
    throw new Error('path escapes the project');
  }
  const abs = path.resolve(directory, raw);
  const withSep = directory.endsWith(path.sep) ? directory : directory + path.sep;
  if (abs !== directory && !abs.startsWith(withSep)) {
    throw new Error('path escapes the project');
  }
  await paths.assertInsideJail(abs, directory);
  return abs;
}

/** Project-relative posix path for a jailed absolute path (never outside). */
export function relativeToolPath(directory: string, abs: string): string {
  const rel = path.relative(directory, abs);
  return (rel.length === 0 ? '.' : rel).replace(/\\/g, '/');
}
