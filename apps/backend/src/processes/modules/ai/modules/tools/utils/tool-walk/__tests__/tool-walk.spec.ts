/**
 * Tool walk util checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/tools/utils/tool-walk/__tests__/tool-walk.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * `WorkspacePathService.readDir` is stubbed with a small in-memory tree (no
 * fs): symlinks are skipped, default `skipDirs` (.git/node_modules/dist/...)
 * are pruned, `maxEntries` and a callback `true` both stop the walk, and every
 * yielded file carries a posix relative + absolute path pair.
 */
import assert from "node:assert/strict";
import type {
  DirEntry,
  WorkspacePathService,
} from "@common/storage/workspace-path.service";
import { type WalkFile, walkFiles } from "../tool-walk.util";

type TreeEntry = { name: string; kind: "file" | "dir" | "symlink" };

type Tree = Record<string, Array<TreeEntry>>;

const ROOT = "/repos/orgs/org/projects/project/content";

const TREE: Tree = {
  [ROOT]: [
    { name: "src", kind: "dir" },
    { name: ".git", kind: "dir" },
    { name: "node_modules", kind: "dir" },
    { name: "root.md", kind: "file" },
    { name: "link.ts", kind: "symlink" },
  ],
  [`${ROOT}/src`]: [
    { name: "a.ts", kind: "file" },
    { name: "nested", kind: "dir" },
  ],
  [`${ROOT}/src/nested`]: [{ name: "b.ts", kind: "file" }],
  [`${ROOT}/.git`]: [{ name: "config", kind: "file" }],
  [`${ROOT}/node_modules`]: [{ name: "dep.js", kind: "file" }],
};

function toDirEntry(entry: TreeEntry): DirEntry {
  return {
    name: entry.name,
    isDirectory: (): boolean => entry.kind === "dir",
    isFile: (): boolean => entry.kind === "file",
    isSymbolicLink: (): boolean => entry.kind === "symlink",
  };
}

/** Structural stub: only `readDir` is reached by `walkFiles` (no fs). */
function stubPaths(tree: Tree): WorkspacePathService {
  return {
    readDir: async (absolutePath: string): Promise<Array<DirEntry>> =>
      (tree[absolutePath] ?? []).map(toDirEntry),
  } as unknown as WorkspacePathService;
}

async function collect(options?: {
  maxEntries?: number;
}): Promise<Array<WalkFile>> {
  const files: Array<WalkFile> = [];
  await walkFiles(
    stubPaths(TREE),
    ROOT,
    (file: WalkFile): void => {
      files.push(file);
    },
    options,
  );
  return files;
}

type Check = { name: string; run: () => Promise<void> };

const checks: Array<Check> = [
  {
    name: "walks files, skips symlinks and prunes default skipDirs",
    run: async () => {
      const files: Array<WalkFile> = await collect();
      const relativeList: Array<string> = files.map((file) => file.relative).sort();
      assert.deepEqual(relativeList, ["root.md", "src/a.ts", "src/nested/b.ts"]);
    },
  },
  {
    name: "yields posix relative + absolute paths",
    run: async () => {
      const files: Array<WalkFile> = await collect();
      for (const file of files) {
        assert.equal(file.absolute, `${ROOT}/${file.relative}`);
        assert.ok(!file.relative.includes("\\"), "relative path must be posix");
      }
    },
  },
  {
    name: "stops at maxEntries",
    run: async () => {
      const files: Array<WalkFile> = await collect({ maxEntries: 1 });
      assert.equal(files.length, 1);
    },
  },
  {
    name: "honors a callback true stop",
    run: async () => {
      const seen: Array<string> = [];
      await walkFiles(stubPaths(TREE), ROOT, (file: WalkFile): boolean => {
        seen.push(file.relative);
        return true;
      });
      assert.equal(seen.length, 1);
    },
  },
  {
    name: "prunes caller-provided skipDirs",
    run: async () => {
      const seen: Array<string> = [];
      await walkFiles(
        stubPaths(TREE),
        ROOT,
        (file: WalkFile): void => {
          seen.push(file.relative);
        },
        { skipDirs: new Set(["src", ".git", "node_modules"]) },
      );
      const relativeList: Array<string> = seen.sort();
      assert.deepEqual(relativeList, ["root.md"]);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} tool-walk checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} tool-walk checks failed`);
  }
  console.log(`${checks.length}/${checks.length} tool-walk checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`tool-walk checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
