import type { WorkspacePathService } from '@common/storage/workspace-path.service';

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
  const maxEntries: number = options?.maxEntries ?? 5_000;
  const skip: ReadonlySet<string> = options?.skipDirs ?? SKIP_DIRS;
  let visited: number = 0;
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
  while (stack.length > 0) {
    const current: { absolute: string; relative: string } | undefined = stack.pop();
    if (!current) break;
    let entries: Awaited<ReturnType<WorkspacePathService['readDir']>>;
    try {
      entries = await paths.readDir(current.absolute);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative: string = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) {
          stack.push({ absolute: `${current.absolute}/${entry.name}`, relative });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      if (visited > maxEntries) return;
      const stop: boolean | void = await onFile({
        relative,
        absolute: `${current.absolute}/${entry.name}`,
      });
      if (stop === true) return;
    }
  }
}
