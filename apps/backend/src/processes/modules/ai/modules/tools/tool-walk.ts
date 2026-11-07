import type { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';

/** Build-noise dirs never walked by glob/grep (jail root stays untouched). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
]);

export type WalkFile = {
  /** Posix path relative to the walk root. */
  relative: string;
  /** Absolute jailed path. */
  absolute: string;
};

/** Bounded recursive walk (files only, symlinks skipped, noise dirs pruned). */
export async function walkFiles(
  paths: WorkspacePathService,
  root: string,
  onFile: (file: WalkFile) => boolean | void | Promise<boolean | void>,
  options?: { maxEntries?: number; skipDirs?: ReadonlySet<string> },
): Promise<void> {
  const maxEntries = options?.maxEntries ?? 5_000;
  const skip = options?.skipDirs ?? SKIP_DIRS;
  let visited = 0;
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: Awaited<ReturnType<WorkspacePathService['readDir']>>;
    try {
      entries = await paths.readDir(current.absolute);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) {
          stack.push({ absolute: `${current.absolute}/${entry.name}`, relative });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      if (visited > maxEntries) return;
      const stop = await onFile({ relative, absolute: `${current.absolute}/${entry.name}` });
      if (stop === true) return;
    }
  }
}

/**
 * Minimal glob matcher: `**` crosses path separators, `*`/`?` stay inside one
 * segment. A pattern without `/` matches the basename (files anywhere).
 */
export function matchGlob(pattern: string, relative: string): boolean {
  const normalized = pattern.replace(/^\.\//, '');
  const target = normalized.includes('/') ? relative : relative.slice(relative.lastIndexOf('/') + 1);
  const source = globToRegExp(normalized);
  return source.test(target);
}

function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if ('\\^$+?.()|{}[]'.includes(char)) {
      out += `\\${char}`;
      continue;
    }
    out += char;
  }
  return new RegExp(`^${out}$`);
}
