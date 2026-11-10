import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppLogger } from '@common/logger';

type ExecFileAsync = (
  file: string,
  args: Array<string>,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileAsync = promisify(execFile);

export type SubmoduleEntry = {
  path: string;
  url: string | null;
  sha: string | null;
  /** Raw first column of `git submodule status` (' ', '+', '-', 'U'). */
  status: string;
};

/** One `[submodule "name"]` section of `.gitmodules` (name discarded). */
export type GitmodulesEntry = {
  path: string;
  url: string | null;
};

/** One parsed `git submodule status` line. */
export type SubmoduleStatusRow = {
  sha: string | null;
  path: string;
  status: string;
};

type GitmodulesSection = {
  path?: string;
  url?: string | null;
};

type WarnLogger = {
  warn(message: unknown): void;
};

export const SUBMODULE_TIMEOUT_MS: number = 30000;

/**
 * Minimal .gitmodules parser (no new deps): `[submodule "name"]` sections
 * with `path = …` / `url = …` pairs. Comments (`#`/`;`) and blank lines
 * are ignored; section names are discarded (paths are the jail key).
 */
export function parseGitmodules(content: string): Array<GitmodulesEntry> {
  const entries: Array<GitmodulesEntry> = [];
  let current: GitmodulesSection | null = null;
  const flush: () => void = () => {
    if (current?.path) entries.push({ path: current.path, url: current.url ?? null });
    current = null;
  };
  for (const rawLine of content.split('\n')) {
    const line: string = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section: RegExpMatchArray | null = line.match(/^\[submodule\s+"[^"]*"\]\s*$/);
    if (section) {
      flush();
      current = {};
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      continue;
    }
    const keyValueMatch: RegExpMatchArray | null = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!keyValueMatch || !current) continue;
    // Tuple destructuring of a regex match — explicit annotation cannot be expressed here.
    const [, key, value] = keyValueMatch;
    if (key === 'path') current.path = value;
    else if (key === 'url') current.url = value;
  }
  flush();
  return entries;
}

/** `  abc1234 libs/shared (v1.0)` → { sha, path, status }. */
export function parseSubmoduleStatus(stdout: string): Array<SubmoduleStatusRow> {
  const entries: Array<SubmoduleStatusRow> = [];
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    const match: RegExpMatchArray | null = rawLine.match(
      /^(.)([0-9a-f]{4,64})\s+(\S+)(?:\s+\(.*\))?\s*$/,
    );
    if (!match) continue;
    // Tuple destructuring of a regex match — explicit annotation cannot be expressed here.
    const [, status, sha, subPath] = match;
    entries.push({ sha, path: subPath, status });
  }
  return entries;
}

/**
 * Jail predicate for gitlink paths: relative posix paths that stay inside
 * the repo (`../../evil`, absolute, URL-encoded escapes rejected).
 */
export function isSubmodulePathSafe(subPath: string): boolean {
  if (!subPath || subPath.includes('\0')) return false;
  let decoded: string = subPath;
  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
  }
  if (path.isAbsolute(decoded) || decoded.startsWith('\\')) return false;
  const relativePath: string = path.posix.normalize(
    decoded.replace(/\\/g, '/').replace(/^\/+/, ''),
  );
  if (!relativePath || relativePath === '.' || relativePath === '..') return false;
  if (relativePath.startsWith('../') || relativePath.includes('/../')) return false;
  if (relativePath.endsWith('/..')) return false;
  return true;
}

/**
 * Read submodules of a cloned repo (readonly: `git submodule status` +
 * `.gitmodules`, execFile without shell). Unsafe gitlink paths (`../../evil`
 * → outside the jail) are skipped with `logger.warn({ path, reason })` and
 * never surface in the response.
 */
export async function readSubmodules(
  absoluteRepo: string,
  logger?: WarnLogger | AppLogger,
): Promise<Array<SubmoduleEntry>> {
  let statusOut: string = '';
  try {
    const response: { stdout: string; stderr: string } = await execFileAsync(
      'git',
      ['submodule', 'status'],
      {
        cwd: absoluteRepo,
        timeout: SUBMODULE_TIMEOUT_MS,
      },
    );
    statusOut = response.stdout ?? '';
  } catch {
    statusOut = '';
  }
  const rows: Array<SubmoduleStatusRow> = parseSubmoduleStatus(statusOut);

  let gitmodules: Array<GitmodulesEntry> = [];
  try {
    const raw: string = await readFile(path.join(absoluteRepo, '.gitmodules'), 'utf8');
    gitmodules = parseGitmodules(raw);
  } catch {
    gitmodules = [];
  }
  const urlByPath: Map<string, string | null> = new Map(
    gitmodules.map((entry) => [entry.path, entry.url]),
  );

  const paths: Set<string> = new Set<string>([
    ...rows.map((row) => row.path),
    ...gitmodules.map((entry) => entry.path),
  ]);
  const shaByPath: Map<string, SubmoduleStatusRow> = new Map(
    rows.map((submoduleRow) => [submoduleRow.path, submoduleRow]),
  );
  const entries: Array<SubmoduleEntry> = [];
  for (const submodulePath of [...paths].sort()) {
    if (!isSubmodulePathSafe(submodulePath)) {
      (logger as WarnLogger | undefined)?.warn?.({
        path: submodulePath,
        reason: 'submodule-path-outside-jail',
      });
      continue;
    }
    const row: SubmoduleStatusRow | undefined = shaByPath.get(submodulePath);
    entries.push({
      path: submodulePath,
      url: urlByPath.get(submodulePath) ?? null,
      sha: row?.sha ?? null,
      status: row?.status ?? ' ',
    });
  }
  return entries;
}
