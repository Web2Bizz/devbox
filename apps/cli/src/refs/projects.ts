// refs/projects — project list + custom dir resolve inside REPOS_ROOT jail.
// Rules mirror refs/resolve.ts: REPOS_ROOT required (fail-fast), ".." denied,
// absolute refs must stay inside the jail (prefix check via realpath).
// Reads only (readdir/stat), previews untouched.

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getReposRoot } from "./resolve.js";

/** Fail-fast empty root (понятная ошибка, не молчаливый []). */
export const EMPTY_ROOT_MESSAGE =
  "[cli] в REPOS_ROOT нет проектов (пустой корень) — положи каталог проекта внутрь REPOS_ROOT или проверь путь в .env (см. .env.example).";

function assertNoTraversal(raw: string): string {
  const clean = raw.trim().replace(/^\.\//, "");
  if (!clean) throw new Error("[cli] пустой путь — введи имя проекта или путь внутри REPOS_ROOT.");
  if (clean.includes("\0")) throw new Error(`[cli] невалидный путь ${JSON.stringify(raw)} — NUL запрещён.`);
  const segments = clean.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`[cli] путь ${JSON.stringify(raw)} — переход ("..") запрещён (jail REPOS_ROOT).`);
  }
  if (segments.some((s) => s === "")) {
    throw new Error(`[cli] путь ${JSON.stringify(raw)} содержит пустой сегмент — проверь путь.`);
  }
  return clean;
}

async function jailResolve(jail: string, clean: string): Promise<string> {
  const abs = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(jail, clean);
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
    throw new Error(`[cli] путь ${JSON.stringify(clean)} выходит за REPOS_ROOT — denied.`);
  }
  return real;
}

/** Scan REPOS_ROOT: top-level dirs (non-dot, sorted). Empty → fail-fast. */
export async function listProjects(root?: string): Promise<string[]> {
  const jail = path.resolve(root ?? getReposRoot());
  let entries: string[];
  try {
    entries = await readdir(jail);
  } catch {
    throw new Error(
      "[cli] REPOS_ROOT недоступен (нет чтения) — проверь путь в .env (см. .env.example).",
    );
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    try {
      const st = await stat(path.join(jail, entry));
      if (st.isDirectory()) dirs.push(entry);
    } catch {
      continue;
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  if (dirs.length === 0) throw new Error(EMPTY_ROOT_MESSAGE);
  return dirs;
}

/** Resolve a listed project name inside the jail (must exist, must be dir). */
export async function resolveProjectDir(name: string, root?: string): Promise<string> {
  const jail = path.resolve(root ?? getReposRoot());
  const clean = assertNoTraversal(name);
  if (path.isAbsolute(clean) || clean.startsWith("/") || clean.startsWith("\\")) {
    throw new Error(`[cli] проект ${JSON.stringify(name)} — только имя внутри REPOS_ROOT (без абсолютных путей).`);
  }
  if (clean.includes("/") || clean.includes("\\")) {
    throw new Error(`[cli] проект ${JSON.stringify(name)} — выбери имя из списка (без вложенных путей).`);
  }
  const real = await jailResolve(jail, clean);
  let st;
  try {
    st = await stat(real);
  } catch {
    throw new Error(`[cli] проект ${JSON.stringify(name)} не найден в REPOS_ROOT. Обнови список.`);
  }
  if (!st.isDirectory()) {
    throw new Error(`[cli] ${JSON.stringify(name)} — не директория.`);
  }
  return real;
}

/** Resolve a custom dir input inside the jail (".." denied, must be dir). */
export async function resolveCustomDir(input: string, root?: string): Promise<string> {
  const jail = path.resolve(root ?? getReposRoot());
  const clean = assertNoTraversal(input);
  const real = await jailResolve(jail, clean);
  let st;
  try {
    st = await stat(real);
  } catch {
    throw new Error(`[cli] путь ${JSON.stringify(input)} не найден в REPOS_ROOT. Проверь путь.`);
  }
  if (!st.isDirectory()) {
    throw new Error(`[cli] путь ${JSON.stringify(input)} — не директория.`);
  }
  return real;
}
