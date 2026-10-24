// core/queries/refs/resolve — file refs inside REPOS_ROOT only (read-only, no fallbacks).
// Rules: REPOS_ROOT required (fail-fast), deny `..` segments, deny absolute
// refs, jail by prefix check, read-only preview with secret scrub.

import { stat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export type ResolvedRef = {
  /** Ref as typed after @ (normalized, no leading ./). */
  ref: string;
  /** Absolute jailed path. */
  absPath: string;
  /** Path relative to REPOS_ROOT (posix). */
  rel: string;
  /** True when the target is a directory. */
  isDir: boolean;
  /** File preview (up to PREVIEW_MAX_CHARS, secrets scrubbed) or dir listing. */
  preview: string;
};

export const PREVIEW_MAX_LINES = 40;
export const PREVIEW_MAX_CHARS = 2000;

/** Fail-fast REPOS_ROOT (no silent fallback to <cwd>/repos). */
export function getReposRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.REPOS_ROOT ?? "").trim();
  if (!raw) {
    throw new Error(
      "[cli] REPOS_ROOT is required (no default, no <cwd>/repos fallback). " +
        "Set REPOS_ROOT in your .env (see .env.example).",
    );
  }
  if (raw.includes("\0")) {
    throw new Error("[cli] REPOS_ROOT must be a valid directory path. Check your .env (see .env.example).");
  }
  return path.resolve(raw);
}

/** Extract @refs from free text (stops at whitespace). */
export function extractRefs(text: string): string[] {
  const out: string[] = [];
  const re = /@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ref = m[1]?.replace(/[.,;:!?)]+$/, "") ?? "";
    if (ref) out.push(ref);
  }
  return out;
}

/** Scrub live secrets from previews (Bearer, basic-auth URLs, key-looking values). */
export function scrubSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s"']+/g, "$1[redacted]")
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@]+:)[^@\s/]+"?@/g, "$1[redacted]@")
    .replace(/:\/\/([^/\s:]+):([^@\s/]+)@/g, "://$1:[redacted]@");
}

function assertRefShape(ref: string): string {
  const clean = ref.trim().replace(/^\.\//, "");
  if (!clean) throw new Error("[cli] empty @ref — usage: @path/to/file (relative to REPOS_ROOT).");
  if (clean.includes("\0")) throw new Error(`[cli] invalid @ref ${JSON.stringify(ref)} — NUL byte rejected.`);
  if (path.isAbsolute(clean) || clean.startsWith("/") || clean.startsWith("\\")) {
    throw new Error(`[cli] @ref ${JSON.stringify(ref)} must be relative to REPOS_ROOT (no absolute paths).`);
  }
  const segments = clean.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`[cli] @ref ${JSON.stringify(ref)} — path traversal ("..") is forbidden.`);
  }
  if (segments.some((s) => s === "")) {
    throw new Error(`[cli] @ref ${JSON.stringify(ref)} has an empty segment — check the path.`);
  }
  return clean;
}

/** Resolve one @ref inside root (async: realpath jail + read-only preview). */
export async function resolveRef(ref: string, root?: string): Promise<ResolvedRef> {
  const jail = path.resolve(root ?? getReposRoot());
  const clean = assertRefShape(ref);
  const abs = path.resolve(jail, clean);
  let realRoot: string;
  try {
    realRoot = await realpath(jail);
  } catch {
    realRoot = jail;
  }
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    real = abs;
  }
  const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (real !== realRoot && !real.startsWith(withSep)) {
    throw new Error(`[cli] @ref ${JSON.stringify(ref)} escapes REPOS_ROOT — denied.`);
  }
  let st;
  try {
    st = await stat(real);
  } catch {
    throw new Error(`[cli] @ref ${JSON.stringify(ref)} not found under REPOS_ROOT. Check the path.`);
  }
  const rel = path.relative(jail, real).split(path.sep).join("/");
  if (st.isDirectory()) {
    const entries = await readdir(real);
    const shown = entries
      .filter((e) => !e.startsWith("."))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, PREVIEW_MAX_LINES);
    const preview = shown.length > 0 ? shown.join("\n") : "(empty directory)";
    return { ref: clean, absPath: real, rel: rel || ".", isDir: true, preview };
  }
  if (!st.isFile()) {
    throw new Error(`[cli] @ref ${JSON.stringify(ref)} is not a readable file.`);
  }
  const raw = await readFile(real, "utf8");
  const lines = raw.split("\n").slice(0, PREVIEW_MAX_LINES).join("\n");
  const preview = scrubSecrets(lines.slice(0, PREVIEW_MAX_CHARS));
  return { ref: clean, absPath: real, rel, isDir: false, preview };
}
