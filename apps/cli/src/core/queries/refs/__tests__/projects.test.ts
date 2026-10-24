// projects jail tests (REPOS_ROOT scan + custom dir resolve).
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects, resolveCustomDir, resolveProjectDir } from "../projects.js";

function makeRoot(entries: Array<{ name: string; dir: boolean }>): string {
  const root = mkdtempSync(join(tmpdir(), "rush-projects-"));
  for (const e of entries) {
    if (e.dir) mkdirSync(join(root, e.name), { recursive: true });
    else writeFileSync(join(root, e.name), "x");
  }
  return root;
}

describe("projects (Выбрать проект / Открыть директорию)", () => {
  test("listProjects returns sorted dirs, skips files and dot-dirs", async () => {
    const root = makeRoot([
      { name: "beta", dir: true },
      { name: "alpha", dir: true },
      { name: "file.txt", dir: false },
      { name: ".hidden", dir: true },
    ]);
    expect(await listProjects(root)).toEqual(["alpha", "beta"]);
  });

  test("empty root is a fail-fast error (no silent [])", async () => {
    const root = makeRoot([]);
    await expect(listProjects(root)).rejects.toThrow("нет проектов");
  });

  test("resolveProjectDir jails traversal and absolutes", async () => {
    const root = makeRoot([{ name: "demo", dir: true }]);
    expect(await resolveProjectDir("demo", root)).toContain("demo");
    await expect(resolveProjectDir("../escape", root)).rejects.toThrow("запрещён");
    await expect(resolveProjectDir("/abs", root)).rejects.toThrow();
  });

  test("resolveCustomDir denies .. escapes, requires a dir", async () => {
    const root = makeRoot([
      { name: "demo", dir: true },
      { name: "note.txt", dir: false },
    ]);
    expect(await resolveCustomDir("demo", root)).toContain("demo");
    await expect(resolveCustomDir("../escape", root)).rejects.toThrow("запрещён");
    await expect(resolveCustomDir("note.txt", root)).rejects.toThrow("не директория");
    await expect(resolveCustomDir("missing", root)).rejects.toThrow("не найден");
  });
});
