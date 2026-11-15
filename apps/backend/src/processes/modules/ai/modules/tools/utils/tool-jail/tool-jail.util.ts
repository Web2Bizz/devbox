import path from 'node:path';
import type { WorkspacePathService } from '@common/storage/workspace-path.service';

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
  const raw: string = relative.trim();
  if (raw.length === 0) throw new Error('path is empty');
  if (raw.includes('\0') || path.isAbsolute(raw)) {
    throw new Error('path escapes the project');
  }
  const absolute: string = path.resolve(directory, raw);
  const withSeparator: string = directory.endsWith(path.sep) ? directory : directory + path.sep;
  if (absolute !== directory && !absolute.startsWith(withSeparator)) {
    throw new Error('path escapes the project');
  }
  await paths.assertInsideJail(absolute, directory);
  return absolute;
}

/** Project-relative posix path for a jailed absolute path (never outside). */
export function relativeToolPath(directory: string, absolute: string): string {
  const relative: string = path.relative(directory, absolute);
  return (relative.length === 0 ? '.' : relative).replace(/\\/g, '/');
}
