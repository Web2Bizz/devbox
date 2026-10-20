import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppLogger } from '../common/app-logger.service';

const execFileAsync = promisify(execFile);

export type SubmoduleEntry = {
  path: string;
  url: string | null;
  sha: string | null;
  /** Raw first column of `git submodule status` (' ', '+', '-', 'U'). */
  status: string;
};

type WarnLogger = {
  warn(message: unknown): void;
};

export const SUBMODULE_TIMEOUT_MS = 30000;

/**
 * Minimal .gitmodules parser (no new deps): `[submodule "name"]` sections
 * with `path = …` / `url = …` pairs. Comments (`#`/`;`) and blank lines
 * are ignored; section names are discarded (paths are the jail key).
 */
export function parseGitmodules(content: string): Array<{ path: string; url: string | null }> {
  const out: Array<{ path: string; url: string | null }> = [];
  let current: { path?: string; url?: string | null } | null = null;
  const flush = () => {
    if (current?.path) out.push({ path: current.path, url: current.url ?? null });
    current = null;
  };
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[submodule\s+"[^"]*"\]\s*$/);
    if (section) {
      flush();
      current = {};
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!kv || !current) continue;
    const [, key, value] = kv;
    if (key === 'path') current.path = value;
    else if (key === 'url') current.url = value;
  }
  flush();
  return out;
}

/** `  abc1234 libs/shared (v1.0)` → { sha, path, status }. */
export function parseSubmoduleStatus(
  stdout: string,
): Array<{ sha: string | null; path: string; status: string }> {
  const out: Array<{ sha: string | null; path: string; status: string }> = [];
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    const m = rawLine.match(/^(.)([0-9a-f]{4,64})\s+(\S+)(?:\s+\(.*\))?\s*$/);
    if (!m) continue;
    const [, status, sha, subPath] = m;
    out.push({ sha, path: subPath, status });
  }
  return out;
}

/**
 * Jail predicate for gitlink paths: relative posix paths that stay inside
 * the repo (`../../evil`, absolute, URL-encoded escapes rejected).
 */
export function isSubmodulePathSafe(subPath: string): boolean {
  if (!subPath || subPath.includes('\0')) return false;
  let decoded = subPath;
  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
  }
  if (path.isAbsolute(decoded) || decoded.startsWith('\\')) return false;
  const rel = path.posix.normalize(decoded.replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) return false;
  if (rel.includes('/../') || rel.endsWith('/..')) return false;
  return true;
}

/**
 * Read submodules of a cloned repo (readonly: `git submodule status` +
 * `.gitmodules`, execFile without shell). Unsafe gitlink paths (`../../evil`
 * → outside the jail) are skipped with `logger.warn({ path, reason })` and
 * never surface in the response.
 */
export async function readSubmodules(
  absRepo: string,
  logger?: WarnLogger | AppLogger,
): Promise<SubmoduleEntry[]> {
  let statusOut = '';
  try {
    const res = await execFileAsync('git', ['submodule', 'status'], {
      cwd: absRepo,
      timeout: SUBMODULE_TIMEOUT_MS,
    });
    statusOut = res.stdout ?? '';
  } catch {
    statusOut = '';
  }
  const rows = parseSubmoduleStatus(statusOut);

  let gitmodules: Array<{ path: string; url: string | null }> = [];
  try {
    const raw = await readFile(path.join(absRepo, '.gitmodules'), 'utf8');
    gitmodules = parseGitmodules(raw);
  } catch {
    gitmodules = [];
  }
  const urlByPath = new Map(gitmodules.map((g) => [g.path, g.url]));

  const paths = new Set<string>([
    ...rows.map((r) => r.path),
    ...gitmodules.map((g) => g.path),
  ]);
  const shaByPath = new Map(rows.map((r) => [r.path, r]));
  const out: SubmoduleEntry[] = [];
  for (const p of [...paths].sort()) {
    if (!isSubmodulePathSafe(p)) {
      (logger as WarnLogger | undefined)?.warn?.({
        path: p,
        reason: 'submodule-path-outside-jail',
      });
      continue;
    }
    const row = shaByPath.get(p);
    out.push({
      path: p,
      url: urlByPath.get(p) ?? null,
      sha: row?.sha ?? null,
      status: row?.status ?? ' ',
    });
  }
  return out;
}
